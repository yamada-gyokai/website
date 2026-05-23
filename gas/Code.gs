// =============================================================================
// Code.gs
// 株式会社 業務の改善 — Google Docs → article HTML 生成スクリプト
// =============================================================================
//
// 【実行手順】
//   1. CONFIG の各値を書き換える
//   2. 上部ドロップダウンで「main」を選択
//   3. ▶ 実行 をクリック
//   4. 初回のみ「権限の確認」ダイアログが出る → 「許可」を押す
//   5. 実行ログに「✓ Drive 保存完了」が出れば成功
//
// 【必要な権限】
//   Google Drive（読み書き）のみ。追加API有効化は不要。
//
// =============================================================================


// =============================================================================
// ▼▼▼ ここだけ書き換えて実行する ▼▼▼
// =============================================================================

var CONFIG = {

  // 変換したい Google Docs の URL をそのまま貼る
  DOC_URL: "https://docs.google.com/document/d/ここにURLを貼る/edit",

  // article-template.html を Google Drive にアップロードしたときのファイルID
  // （DriveのURL: https://drive.google.com/file/d/【この部分】/view）
  TEMPLATE_FILE_ID: "ここにファイルIDを貼る",

  // 生成した HTML を保存するフォルダID（空文字 "" にするとマイドライブ直下に保存）
  OUTPUT_FOLDER_ID: "",

  // 生成ファイルの名前（.html は自動付与される）
  SLUG: "homepage-renewal",

  // 記事のタイトル（<title>タグ・h1・パンくずに使われる）
  TITLE: "ホームページをリニューアルしています",

  // 公開日
  DATE: "2026年5月22日",

  // カテゴリ名（パンくず・記事メタに使われる）
  CATEGORY: "サイトについて",

  // リード文（記事冒頭の1〜2文。Google Docsの冒頭とは別に手動で書く）
  LEAD: "サイトを作り直しています。以前のサイトは「IT会社のホームページ」に見えていました。それが、私たちがやっていることとは少しずれていると気づいたので、作り直すことにしました。"

};

// =============================================================================
// ▲▲▲ 書き換えはここまで ▲▲▲
// =============================================================================




// =============================================================================
// メイン実行関数
// GAS 上部のドロップダウンで「main」を選んで ▶ 実行する
// =============================================================================

function main() {

  // STEP 1: Google Docs の URL から docId を取り出す
  var docId = extractDocId(CONFIG.DOC_URL);
  Logger.log("STEP1 完了: docId = " + docId);

  // STEP 2: Google Docs を HTML 形式で取得する
  var rawHtml = getDocAsHtml(docId);
  Logger.log("STEP2 完了: 生HTML文字数 = " + rawHtml.length);

  // STEP 3: 不要なタグ・属性を削除し、semantic classを付与する
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

  // 先頭3000文字をログで確認
  Logger.log("======= 完成HTML（先頭3000文字）=======");
  Logger.log(articleHtml.substring(0, 3000));
}




// =============================================================================
// STEP 1: Google Docs URL から docId を抽出する
// =============================================================================
//
// 対応URL形式:
//   https://docs.google.com/document/d/xxxxx/edit
//   https://docs.google.com/document/d/xxxxx/edit?usp=sharing
//
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
// DriveApp を使って HTML 形式でエクスポートする。
// 追加APIの有効化は不要。
//
function getDocAsHtml(docId) {
  var file = DriveApp.getFileById(docId);
  var blob = file.getAs("text/html");
  return blob.getDataAsString();
}




// =============================================================================
// STEP 3: HTML クリーニングのパイプライン
// =============================================================================
//
// 以下の順で処理する:
//   (1) <body> 内だけを取り出す
//   (2) <style> <script> ブロックを削除する
//   (3) <span> タグを削除する（中身は残す）
//   (4) class/id/style などの属性を削除する（href, src, alt は残す）
//   (5) h1/h2/p などに article-* の semantic class を付与する
//   (6) 空の <p> タグを削除する
//
function cleanDocHtml(rawHtml) {
  var html = rawHtml;
  html = extractBody(html);           // (1)
  html = removeBlockTags(html);       // (2)
  html = removeSpans(html);           // (3)
  html = stripAttributes(html);       // (4)
  html = addSemanticClasses(html);    // (5)
  html = removeEmptyParagraphs(html); // (6)
  html = html.replace(/\n{3,}/g, "\n\n"); // 連続する空行を整理
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


// (2) <style>...</style> と <script>...</script> を丸ごと削除する
function removeBlockTags(html) {
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  return html;
}


// (3) <span class="..."> ... </span> のタグだけ削除し、中身は残す
//     Google Docs はスタイル付きテキストを span で大量にラップするため
function removeSpans(html) {
  html = html.replace(/<span[^>]*>/gi, "");
  html = html.replace(/<\/span>/gi, "");
  return html;
}


// (4) 全タグから属性を削除する
//     例外: <a> の href と <img> の src・alt は残す
function stripAttributes(html) {
  return html.replace(/<([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\s*\/?)>/g, function(match, tag, attrs, selfClose) {
    var t = tag.toLowerCase();

    // <a> タグ: href だけ残す
    if (t === "a") {
      var hrefMatch = attrs.match(/href="([^"]*)"/i);
      if (hrefMatch) {
        return "<a href=\"" + hrefMatch[1] + "\">";
      }
      return "<a>";
    }

    // <img> タグ: src と alt だけ残す
    if (t === "img") {
      var srcMatch = attrs.match(/src="([^"]*)"/i);
      var altMatch = attrs.match(/alt="([^"]*)"/i);
      var src = srcMatch ? " src=\"" + srcMatch[1] + "\"" : "";
      var alt = altMatch ? " alt=\"" + altMatch[1] + "\"" : "";
      return "<img" + src + alt + ">";
    }

    // その他のタグ: 属性を全削除（自己終了タグは /> を保持）
    if (selfClose.trim()) {
      return "<" + tag + " />";
    }
    return "<" + tag + ">";
  });
}


// (5) タグに article-* の semantic class を付与する
//     article.css で定義されているクラス名に合わせている
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


// (6) 空の <p> タグ（中身が空白・&nbsp; だけ）を削除する
function removeEmptyParagraphs(html) {
  return html.replace(/<p[^>]*>(\s|&nbsp;)*<\/p>/gi, "");
}




// =============================================================================
// STEP 4: article-template.html を Drive から読み込む
// =============================================================================
//
// article-template.html を Google Drive にアップロードし、
// そのファイルID を CONFIG.TEMPLATE_FILE_ID に設定しておく。
//
function loadTemplate(fileId) {
  var file = DriveApp.getFileById(fileId);
  return file.getBlob().getDataAsString();
}




// =============================================================================
// STEP 5: テンプレートのプレースホルダに値を差し込む
// =============================================================================
//
// article-template.html 内のプレースホルダ一覧:
//   {{PAGE_TITLE}}         → <title> タグ内のタイトル
//   {{TITLE}}              → <h1> とパンくずのタイトル（複数箇所）
//   {{CATEGORY}}           → カテゴリ名（複数箇所）
//   {{DATE}}               → 公開日
//   {{LEAD}}               → リード文（1〜2文）
//   <!-- ARTICLE_CONTENT → Google Docs 本文（クリーニング済み）
//
// また、テンプレートは root 相対パスで書かれているため、
// articles/ サブディレクトリ用に ../ へ変換する。
//
function buildArticleHtml(template, cleanedContent, config) {
  var html = template;

  // プレースホルダを値で置換（split+join で全出現を一括置換）
  html = html.split("{{PAGE_TITLE}}").join(config.TITLE);
  html = html.split("{{TITLE}}").join(config.TITLE);
  html = html.split("{{CATEGORY}}").join(config.CATEGORY);
  html = html.split("{{DATE}}").join(config.DATE);
  html = html.split("{{LEAD}}").join(config.LEAD);

  // 本文を差し込む
  html = html.replace("<!-- ARTICLE_CONTENT -->", cleanedContent);

  // パスを articles/ サブディレクトリ用に修正する
  html = fixPaths(html);

  return html;
}


// テンプレート内の相対パスを articles/ サブディレクトリ用に変換する
// 例: href="article.css" → href="../article.css"
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
//
// CONFIG.OUTPUT_FOLDER_ID が空文字の場合はマイドライブ直下に保存される。
// ファイル名は CONFIG.SLUG + ".html" になる。
//
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
