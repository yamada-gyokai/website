// =============================================================================
// Code.gs
// 株式会社 業務の改善 — Google Docs → article HTML 生成スクリプト
// =============================================================================
//
// 【事前準備: Advanced Google Services の有効化】
//   このスクリプトは Drive API（Advanced Google Services）を使用します。
//   以下の手順で有効化してください:
//     1. Apps Script エディタ左メニューの「サービス」横の「+」をクリック
//     2. 一覧から「Drive API」を選択
//     3. 「追加」ボタンをクリック
//     4. 左メニューに「Drive v2」または「Drive v3」が表示されれば成功
//
// 【実行手順】
//   1. 上記の Drive API を有効化する（初回のみ）
//   2. CONFIG の各値を書き換える
//   3. 上部ドロップダウンで「main」を選択
//   4. ▶ 実行 をクリック
//   5. 初回のみ「権限の確認」ダイアログが出る → 「許可」を押す
//   6. 実行ログに「STEP6 完了: Drive に保存しました」が出れば成功
//
// =============================================================================


// =============================================================================
// ▼▼▼ ここだけ書き換えて実行する ▼▼▼
// =============================================================================

var CONFIG = {

  // 変換したい Google Docs の URL をそのまま貼る
  DOC_URL: "https://docs.google.com/document/d/ここにURLを貼る/edit",

  // article-template.html を Google Drive にアップロードしたときのファイルID
  // Drive の共有URL: https://drive.google.com/file/d/【この部分】/view
  TEMPLATE_FILE_ID: "ここにファイルIDを貼る",

  // 生成した HTML を保存するフォルダID
  // 空文字 "" にするとマイドライブ直下に保存される
  OUTPUT_FOLDER_ID: "",

  // 生成ファイルの名前（.html は自動付与される）
  SLUG: "homepage-renewal",

  // 記事タイトル（<title>・h1・パンくずに使われる）
  TITLE: "ホームページをリニューアルしています",

  // 公開日
  DATE: "2026年5月22日",

  // カテゴリ名（パンくず・記事メタに使われる）
  CATEGORY: "サイトについて",

  // リード文（記事冒頭の1〜2文。Google Docs の冒頭文とは別に手動で入力する）
  LEAD: "サイトを作り直しています。以前のサイトは「IT会社のホームページ」に見えていました。それが、私たちがやっていることとは少しずれていると気づいたので、作り直すことにしました。"

};

// =============================================================================
// ▲▲▲ 書き換えはここまで ▲▲▲
// =============================================================================




// =============================================================================
// メイン実行関数
// GAS 上部ドロップダウンで「main」を選んで ▶ 実行する
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
//
// 対応 URL 形式:
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
// 【重要】DriveApp.getAs("text/html") は Google Docs ネイティブファイルに非対応。
//   "Converting from application/vnd.google-apps.document to text/html
//    is not supported." エラーが発生するため、Drive API の exportLinks を使う。
//
// 【必要な設定】
//   Apps Script エディタ → サービス「+」→「Drive API」を追加する。
//   追加後に Drive.Files.get() が使えるようになる。
//
// 処理の流れ:
//   1. Drive.Files.get() でファイルの exportLinks を取得する
//   2. exportLinks["text/html"] でエクスポート用URLを取り出す
//   3. UrlFetchApp.fetch() で OAuth 認証しながら HTML をダウンロードする
//
function getDocAsHtml(docId) {

  // Drive API でファイルのエクスポートリンク一覧を取得する
  // （Drive API が Advanced Google Services で有効になっている必要がある）
  var fileInfo = Drive.Files.get(docId, { fields: "exportLinks" });

  // text/html 形式のエクスポート URL を取り出す
  var exportUrl = fileInfo.exportLinks["text/html"];
  if (!exportUrl) {
    throw new Error("text/html のエクスポートURLが取得できませんでした。ファイルが Google Docs 形式か確認してください。");
  }

  // OAuth トークンで認証してHTMLをダウンロードする
  var response = UrlFetchApp.fetch(exportUrl, {
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  });

  // レスポンスコードを確認する（200以外はエラー）
  var statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    throw new Error("HTML取得に失敗しました。レスポンスコード: " + statusCode + " / URL: " + exportUrl);
  }

  return response.getContentText("UTF-8");
}




// =============================================================================
// STEP 3: HTML クリーニングのパイプライン
// =============================================================================
//
// Google Docs からエクスポートされた HTML には不要な情報が大量に含まれる。
// 以下の順で不要部分を取り除き、article.css 用の class を付与する:
//
//   (1) <body> の中身だけを取り出す
//   (2) <style> <script> ブロックを削除する
//   (3) <span> タグを削除する（中身は残す）
//   (4) class / id / style などの属性を削除する（href, src, alt は残す）
//   (5) h1 / h2 / p などに article-* の semantic class を付与する
//   (6) 空の <p> タグを削除する
//
function cleanDocHtml(rawHtml) {
  var html = rawHtml;
  html = extractBody(html);            // (1)
  html = removeBlockTags(html);        // (2)
  html = removeSpans(html);            // (3)
  html = stripAttributes(html);        // (4)
  html = addSemanticClasses(html);     // (5)
  html = removeEmptyParagraphs(html);  // (6)
  html = html.replace(/\n{3,}/g, "\n\n"); // 連続する空行を整理する
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


// (2) <style>...</style> と <script>...</script> ブロックを丸ごと削除する
function removeBlockTags(html) {
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  return html;
}


// (3) <span class="..."> タグだけ削除し、中身のテキストは残す
//     Google Docs はスタイル付きテキストを span で大量にラップするため
function removeSpans(html) {
  html = html.replace(/<span[^>]*>/gi, "");
  html = html.replace(/<\/span>/gi, "");
  return html;
}


// (4) 全タグから属性を削除する
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

    // それ以外のタグ: 属性を全削除する（自己終了タグは /> を保持する）
    if (selfClose.trim()) {
      return "<" + tag + " />";
    }
    return "<" + tag + ">";
  });
}


// (5) タグに article.css の semantic class を付与する
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


// (6) 空の <p> タグ（中身が空白や &nbsp; だけのもの）を削除する
function removeEmptyParagraphs(html) {
  return html.replace(/<p[^>]*>(\s|&nbsp;)*<\/p>/gi, "");
}




// =============================================================================
// STEP 4: article-template.html を Drive から読み込む
// =============================================================================
//
// 事前に article-template.html を Google Drive にアップロードし、
// そのファイルID を CONFIG.TEMPLATE_FILE_ID に設定しておく。
//
// ファイルID の確認方法:
//   Drive でファイルを右クリック →「リンクを取得」→
//   https://drive.google.com/file/d/【ここ】/view の「ここ」部分
//
function loadTemplate(fileId) {
  var file = DriveApp.getFileById(fileId);
  return file.getBlob().getDataAsString("UTF-8");
}




// =============================================================================
// STEP 5: テンプレートのプレースホルダに値を差し込む
// =============================================================================
//
// article-template.html 内のプレースホルダ一覧:
//   {{PAGE_TITLE}}          → <title> タグ内のタイトル
//   {{TITLE}}               → <h1>・パンくずのタイトル（複数箇所）
//   {{CATEGORY}}            → カテゴリ名（複数箇所）
//   {{DATE}}                → 公開日
//   {{LEAD}}                → リード文（1〜2文）
//   <!-- ARTICLE_CONTENT --> → Google Docs 本文（クリーニング済み）
//
// また、テンプレートは root 相対パスで書かれているため、
// articles/ サブディレクトリ用に ../ へ変換する。
//
function buildArticleHtml(template, cleanedContent, config) {
  var html = template;

  // split + join で全出現箇所を一括置換する
  // （String.replace() はデフォルトで最初の1件しか置換しないため）
  html = html.split("{{PAGE_TITLE}}").join(config.TITLE);
  html = html.split("{{TITLE}}").join(config.TITLE);
  html = html.split("{{CATEGORY}}").join(config.CATEGORY);
  html = html.split("{{DATE}}").join(config.DATE);
  html = html.split("{{LEAD}}").join(config.LEAD);

  // 本文を差し込む（1箇所のみなので replace で十分）
  html = html.replace("<!-- ARTICLE_CONTENT -->", cleanedContent);

  // パスを articles/ サブディレクトリ用に修正する
  html = fixPaths(html);

  return html;
}


// テンプレートの root 相対パスを articles/ 用の ../ に変換する
// 例: href="article.css" → href="../article.css"
// 例: src="assets/logo.svg" → src="../assets/logo.svg"
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
// 保存後にログに Drive の URL が表示される。
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
