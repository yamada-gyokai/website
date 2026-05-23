// =============================================================================
// Code.gs
// 株式会社 業務の改善 — Google Docs → article HTML 生成スクリプト
// =============================================================================
//
// 【必要な設定】
//   Advanced Google Services の有効化は不要。
//   DriveApp と UrlFetchApp のみ使用（どちらも GAS 標準サービス）。
//
// 【実行手順】
//   1. CONFIG の値を確認・必要なら書き換える
//   2. 上部ドロップダウンで「main」を選択
//   3. ▶ 実行 をクリック
//   4. 初回のみ「権限の確認」ダイアログが出る → 「許可」を押す
//   5. 実行ログに「STEP6 完了: Drive に保存しました」が出れば成功
//
// 【Google Docs の書き方ルール】
//   Google Docs には「本文だけ」を書く。
//   以下はテンプレート（CONFIG）が自動で挿入するため、Docs には書かない:
//     - カテゴリ名
//     - 公開日
//     - リード文
//   Docs で使う見出しは H2・H3 のみ。H1 は Docs のタイトルのみ（自動除去される）。
//
// =============================================================================


// =============================================================================
// ▼▼▼ CONFIG: 記事ごとにここだけ書き換えて実行する ▼▼▼
// =============================================================================

var CONFIG = {

  // 変換したい Google Docs の URL
  DOC_URL: "https://docs.google.com/document/d/1p1H-MzngzKkgsXyyMcFTkKvym9i1JxxGx5N01C6ULTI/edit",

  // article-template.html を Google Drive にアップロードしたときのファイルID
  // Drive URL: https://drive.google.com/file/d/【この部分】/view
  TEMPLATE_FILE_ID: "1dhOSgOEvGjA5Zbt5dThaNgO5q16ZXRne",

  // 生成した HTML を保存するフォルダID
  OUTPUT_FOLDER_ID: "1k4LkETfYEP4Idqhno9CcHjNdKcm964cX",

  // 生成ファイルの名前（.html は自動付与される）
  SLUG: "homepage-renewal",

  // 記事タイトル（<title>・h1・パンくずに使われる）
  TITLE: "ホームページをリニューアルしています",

  // 公開日
  DATE: "2026年5月22日",

  // カテゴリ名（パンくず・記事メタに使われる）
  CATEGORY: "サイトについて",

  // リード文（記事冒頭の1〜2文）
  LEAD: "サイトを作り直しています。以前のサイトは「IT会社のホームページ」に見えていました。それが、私たちがやっていることとは少しずれていると気づいたので、作り直すことにしました。"

};

// =============================================================================
// ▲▲▲ 書き換えはここまで ▲▲▲
// =============================================================================




// =============================================================================
// メイン実行関数
// ドロップダウンで「main」を選んで ▶ 実行する
// =============================================================================

function main() {

  // STEP 1: Google Docs URL から docId を取り出す
  var docId = extractDocId(CONFIG.DOC_URL);
  Logger.log("STEP1 完了: docId = " + docId);

  // STEP 2: Google Docs を HTML 形式で取得する
  var rawHtml = getDocAsHtml(docId);
  Logger.log("STEP2 完了: 生HTML文字数 = " + rawHtml.length);

  // STEP 3: 不要タグ・属性を削除して semantic class を付与する
  var cleanedHtml = cleanDocHtml(rawHtml);
  Logger.log("STEP3 完了: クリーニング後文字数 = " + cleanedHtml.length);

  // STEP 4: article-template.html を Google Drive から読み込む
  var template = loadTemplate(CONFIG.TEMPLATE_FILE_ID);
  Logger.log("STEP4 完了: テンプレート文字数 = " + template.length);

  // STEP 5: テンプレートのプレースホルダに値を差し込む
  var articleHtml = buildArticleHtml(template, cleanedHtml, CONFIG);
  Logger.log("STEP5 完了: 完成HTML文字数 = " + articleHtml.length);

  // プレースホルダが残っていたら警告（差し込み失敗のサイン）
  if (articleHtml.indexOf("<!-- ARTICLE_CONTENT -->") !== -1) {
    Logger.log("WARNING: ARTICLE_CONTENT が差し込まれていません。テンプレートを確認してください。");
  }
  if (articleHtml.indexOf("{{TITLE}}") !== -1) {
    Logger.log("WARNING: {{TITLE}} が残っています。テンプレートを確認してください。");
  }

  // STEP 6: 完成した HTML を Google Drive に保存する
  saveHtmlToDrive(articleHtml, CONFIG.SLUG, CONFIG.OUTPUT_FOLDER_ID);

  // 先頭 3000 文字をログで確認
  Logger.log("======= 完成HTML（先頭3000文字）=======");
  Logger.log(articleHtml.substring(0, 3000));
}




// =============================================================================
// STEP 1: Google Docs URL から docId を抽出する
// =============================================================================

function extractDocId(url) {
  var match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error("有効な Google Docs URL ではありません: " + url);
  }
  return match[1];
}




// =============================================================================
// STEP 2: Google Docs を HTML 文字列として取得する
// =============================================================================
//
// Google Docs export エンドポイントを直接 fetch する。
// Drive API の exportLinks 方式は GAS バージョン差異で不安定なため使わない。
//
function getDocAsHtml(docId) {

  var url =
    "https://docs.google.com/feeds/download/documents/export/Export?id=" +
    docId +
    "&exportFormat=html";

  var token = ScriptApp.getOAuthToken();

  var response = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: "Bearer " + token
    },
    muteHttpExceptions: true
  });

  var statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    throw new Error("HTML の取得に失敗しました。ステータスコード: " + statusCode);
  }

  return response.getContentText();
}




// =============================================================================
// STEP 3: HTML クリーニングのパイプライン
// =============================================================================
//
// 処理順序:
//   (1)  extractBody()            — <body> の中身だけ取り出す
//   (2)  removeGoogleDocsMeta()   — H1タイトル・先頭メタ段落を除去する
//   (3)  removeHrTags()           — Google Docs 由来の不要な罫線を除去する
//   (4)  removeBlockTags()        — <style> <script> を除去する
//   (5)  removeSpans()            — <span> タグを除去する（中身は残す）
//   (6)  stripAttributes()        — 属性を除去する（href, src, alt は残す）
//   (7)  removeEmptyDivs()        — 空の div・<div><br></div> を除去する
//   (8)  removeRedundantBreaks()  — 不要な <br> を除去する
//   (9)  addSemanticClasses()     — article-* の semantic class を付与する
//   (10) removeEmptyParagraphs()  — 空の <p> を除去する
//
function cleanDocHtml(rawHtml) {
  var html = rawHtml;
  html = extractBody(html);            // (1)
  html = removeGoogleDocsMeta(html);   // (2)
  html = removeHrTags(html);           // (3)
  html = removeBlockTags(html);        // (4)
  html = removeSpans(html);            // (5)
  html = stripAttributes(html);        // (6)
  html = removeEmptyDivs(html);        // (7)
  html = removeRedundantBreaks(html);  // (8)
  html = addSemanticClasses(html);     // (9)
  html = removeEmptyParagraphs(html);  // (10)
  html = html.replace(/\n{3,}/g, "\n\n");
  return html.trim();
}


// (1) <body>...</body> の中身だけを取り出す
function extractBody(html) {
  var match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!match) {
    throw new Error("<body> タグが見つかりませんでした");
  }
  return match[1];
}


// (2) Google Docs のメタ情報を除去する
//
// Google Docs は以下を自動で挿入する:
//   - ドキュメントタイトルを <h1> として body 冒頭に出力する
//   - body 冒頭の段落にカテゴリ・日付・リードなどが含まれる場合がある
//
// 処理:
//   A) 最初の <h1>...</h1> を削除する（ドキュメントタイトル）
//   B) 最初の <h2>/<h3> が来る前にある全 <p> タグを削除する
//      （テンプレート側で挿入済みのメタ段落の重複を防ぐ）
//
function removeGoogleDocsMeta(html) {

  // A) 最初の H1 を削除する
  html = html.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, "");

  // B) 最初の H2/H3 が来る前の P タグを全て削除する
  var firstContentIndex = html.search(/<h[23][^>]*>/i);
  if (firstContentIndex > 0) {
    var beforeContent = html.substring(0, firstContentIndex);
    var fromContent   = html.substring(firstContentIndex);
    beforeContent = beforeContent.replace(/<p[^>]*>[\s\S]*?<\/p>/gi, "");
    html = beforeContent + fromContent;
  }

  return html;
}


// (3) <hr> タグを全て除去する
//     Google Docs が生成する不要な罫線・セパレータを取り除く
function removeHrTags(html) {
  return html.replace(/<hr[^>]*\/?>/gi, "");
}


// (4) <style>...</style> と <script>...</script> を丸ごと削除する
function removeBlockTags(html) {
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  return html;
}


// (5) <span class="..."> タグだけ削除し、中身のテキストは残す
//     Google Docs はスタイル付きテキストを span で大量にラップするため
function removeSpans(html) {
  html = html.replace(/<span[^>]*>/gi, "");
  html = html.replace(/<\/span>/gi, "");
  return html;
}


// (6) 全タグから属性を削除する
//     例外: <a> の href と <img> の src・alt は残す
function stripAttributes(html) {
  return html.replace(/<([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\s*\/?)>/g, function(fullMatch, tag, attrs, selfClose) {
    var t = tag.toLowerCase();

    // <a> タグは href だけ残す
    if (t === "a") {
      var hrefMatch = attrs.match(/href="([^"]*)"/i);
      if (hrefMatch) {
        return "<a href=\"" + hrefMatch[1] + "\">";
      }
      return "<a>";
    }

    // <img> タグは src と alt だけ残す
    if (t === "img") {
      var srcMatch = attrs.match(/src="([^"]*)"/i);
      var altMatch = attrs.match(/alt="([^"]*)"/i);
      var src = srcMatch ? " src=\"" + srcMatch[1] + "\"" : "";
      var alt = altMatch ? " alt=\"" + altMatch[1] + "\"" : "";
      return "<img" + src + alt + ">";
    }

    // その他のタグ: 属性を全削除（自己終了タグは /> を保持する）
    if (selfClose.trim()) {
      return "<" + tag + " />";
    }
    return "<" + tag + ">";
  });
}


// (7) 空の div を除去する
//     Google Docs が生成する <div><br></div> や <div></div> を取り除く
function removeEmptyDivs(html) {
  // <div><br></div> を削除する
  html = html.replace(/<div>\s*<br\s*\/?>\s*<\/div>/gi, "");
  // 完全に空の <div></div> を削除する
  html = html.replace(/<div>\s*<\/div>/gi, "");
  return html;
}


// (8) 不要な <br> を除去する
//     段落の先頭・末尾・連続する <br> を整理する
function removeRedundantBreaks(html) {
  // <p> の直後の <br> を削除する（段落冒頭の空行）
  html = html.replace(/(<p>)\s*<br\s*\/?>/gi, "$1");
  // </p> の直前の <br> を削除する（段落末尾の空行）
  html = html.replace(/<br\s*\/?>\s*(<\/p>)/gi, "$1");
  // 連続する <br> を1つにまとめる
  html = html.replace(/(<br\s*\/?>(\s*)){2,}/gi, "<br>");
  return html;
}


// (9) タグに article.css の semantic class を付与する
//     article-divider は hr 除去済みなので実質マッチしないが念のため残す
function addSemanticClasses(html) {
  html = html.replace(/<h1>/gi,         "<h1 class=\"article-h1 reveal\">");
  html = html.replace(/<h2>/gi,         "<h2 class=\"article-h2 reveal\">");
  html = html.replace(/<h3>/gi,         "<h3 class=\"article-h3 reveal\">");
  html = html.replace(/<p>/gi,          "<p class=\"article-body reveal\">");
  html = html.replace(/<blockquote>/gi, "<blockquote class=\"article-quote reveal\">");
  html = html.replace(/<img(\s)/gi,     "<img class=\"article-image reveal\"$1");
  html = html.replace(/<img>/gi,        "<img class=\"article-image reveal\">");
  html = html.replace(/<hr\s*\/?>/gi,   "<hr class=\"article-divider reveal\">");
  return html;
}


// (10) 空の <p> タグ（中身が空白や &nbsp; だけ）を削除する
function removeEmptyParagraphs(html) {
  return html.replace(/<p[^>]*>(\s|&nbsp;)*<\/p>/gi, "");
}




// =============================================================================
// STEP 4: article-template.html を Drive から読み込む
// =============================================================================

function loadTemplate(fileId) {
  var file = DriveApp.getFileById(fileId);
  return file.getBlob().getDataAsString("UTF-8");
}




// =============================================================================
// STEP 5: テンプレートのプレースホルダに値を差し込む
// =============================================================================
//
// article-template.html 内のプレースホルダ:
//   {{PAGE_TITLE}}           → <title> タグ内のタイトル
//   {{TITLE}}                → <h1>・パンくずのタイトル（複数箇所）
//   {{CATEGORY}}             → カテゴリ名（複数箇所）
//   {{DATE}}                 → 公開日
//   {{LEAD}}                 → リード文
//   <!-- ARTICLE_CONTENT --> → Google Docs の本文（クリーニング済み）
//
function buildArticleHtml(template, cleanedContent, config) {
  var html = template;

  // split + join で全出現箇所を一括置換する
  html = html.split("{{PAGE_TITLE}}").join(config.TITLE);
  html = html.split("{{TITLE}}").join(config.TITLE);
  html = html.split("{{CATEGORY}}").join(config.CATEGORY);
  html = html.split("{{DATE}}").join(config.DATE);
  html = html.split("{{LEAD}}").join(config.LEAD);

  // 本文を差し込む（1箇所のみ）
  html = html.replace("<!-- ARTICLE_CONTENT -->", cleanedContent);

  // パスを articles/ サブディレクトリ用に修正する
  html = fixPaths(html);

  return html;
}


// テンプレートの root 相対パスを articles/ 用の ../ に変換する
function fixPaths(html) {
  html = html.replace(/href="article\.css"/g,       "href=\"../article.css\"");
  html = html.replace(/src="assets\//g,             "src=\"../assets/");
  html = html.replace(/href="assets\//g,            "href=\"../assets/");
  html = html.replace(/href="index\.html/g,         "href=\"../index.html");
  html = html.replace(/href="services\.html/g,      "href=\"../services.html");
  html = html.replace(/href="about\.html/g,         "href=\"../about.html");
  html = html.replace(/href="it-consulting\.html/g, "href=\"../it-consulting.html");
  html = html.replace(/href="support\.html/g,       "href=\"../support.html");
  html = html.replace(/href="development\.html/g,   "href=\"../development.html");
  return html;
}




// =============================================================================
// STEP 6: 完成した HTML を Google Drive に保存する
// =============================================================================

function saveHtmlToDrive(html, slug, folderId) {
  var fileName = slug + ".html";
  var blob = Utilities.newBlob(html, "text/html; charset=utf-8", fileName);

  var file;
  if (folderId && folderId !== "") {
    var folder = DriveApp.getFolderById(folderId);
    file = folder.createFile(blob);
  } else {
    file = DriveApp.createFile(blob);
  }

  Logger.log("STEP6 完了: Drive に保存しました");
  Logger.log("ファイル名: " + fileName);
  Logger.log("Drive URL: " + file.getUrl());

  return file;
}
