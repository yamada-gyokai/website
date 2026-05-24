// =============================================================================
// Code.gs
// 株式会社 業務の改善 — Google Docs → article HTML 生成スクリプト（Parser版）
// =============================================================================
//
// 【設計思想】
//   Google Docs export HTML を「クリーニング」するのではなく
//   「パース」して必要ノードだけを抽出し、semantic HTML を再構築する。
//
//   許可するタグ: h2, h3, p, ul, ol, li, blockquote, img
//   除去するもの: style, script, span, div, font, table, hr および全属性
//                 （<a href> と <img src, alt> のみ保持）
//
// 【必要な設定】
//   Advanced Google Services の有効化は不要。GAS 標準サービスのみ使用。
//
// 【実行手順】
//   1. CONFIG の値を確認・必要なら書き換える
//   2. 上部ドロップダウンで「main」を選択
//   3. ▶ 実行 をクリック
//   4. 初回のみ「権限の確認」ダイアログ → 「許可」
//   5. 実行ログに「STEP6 完了」が出れば成功
//
// 【Google Docs の書き方ルール】
//   Docs には「本文だけ」を書く（H2 始まり推奨）。
//   以下は CONFIG が挿入するため Docs には書かない:
//     カテゴリ / 公開日 / リード文
//
// =============================================================================


// =============================================================================
// ▼▼▼ CONFIG: 記事ごとにここだけ書き換えて実行する ▼▼▼
// =============================================================================

var CONFIG = {

  // 変換したい Google Docs の URL
  DOC_URL: "https://docs.google.com/document/d/1p1H-MzngzKkgsXyyMcFTkKvym9i1JxxGx5N01C6ULTI/edit",

  // article-template.html の Google Drive ファイルID
  // Drive URL: https://drive.google.com/file/d/【この部分】/view
  TEMPLATE_FILE_ID: "1dhOSgOEvGjA5Zbt5dThaNgO5q16ZXRne",

  // 生成した HTML を保存するフォルダID
  OUTPUT_FOLDER_ID: "1k4LkETfYEP4Idqhno9CcHjNdKcm964cX",

  // 生成ファイルの名前（.html は自動付与）
  SLUG: "homepage-renewal",

  // 記事タイトル（<title>・h1・パンくずに使われる）
  TITLE: "ホームページをリニューアルしています",

  // 公開日
  DATE: "2026年5月22日",

  // カテゴリ名
  CATEGORY: "サイトについて",

  // リード文（1〜2文）
  LEAD: "サイトを作り直しています。以前のサイトは「IT会社のホームページ」に見えていました。それが、私たちがやっていることとは少しずれていると気づいたので、作り直すことにしました。"

};

// =============================================================================
// ▲▲▲ 書き換えはここまで ▲▲▲
// =============================================================================




// =============================================================================
// メイン実行関数
// =============================================================================

function main() {

  // STEP 1: docId を抽出する
  var docId = extractDocId(CONFIG.DOC_URL);
  Logger.log("STEP1 完了: docId = " + docId);

  // STEP 2: Google Docs を HTML で取得する
  var rawHtml = getDocAsHtml(docId);
  Logger.log("STEP2 完了: 生HTML文字数 = " + rawHtml.length);

  // STEP 3: パースして semantic HTML を再構築する
  var articleContent = parseGoogleDoc(rawHtml);
  Logger.log("STEP3 完了: パース後文字数 = " + articleContent.length);
  Logger.log("--- パース結果（先頭1000文字）---");
  Logger.log(articleContent.substring(0, 1000));

  // STEP 4: テンプレートを読み込む
  var template = loadTemplate(CONFIG.TEMPLATE_FILE_ID);
  Logger.log("STEP4 完了: テンプレート文字数 = " + template.length);

  // STEP 5: プレースホルダに差し込む
  var articleHtml = buildArticleHtml(template, articleContent, CONFIG);
  Logger.log("STEP5 完了: 完成HTML文字数 = " + articleHtml.length);

  if (articleHtml.indexOf("<!-- ARTICLE_CONTENT -->") !== -1) {
    Logger.log("WARNING: ARTICLE_CONTENT が差し込まれていません。テンプレートを確認してください。");
  }

  // STEP 6: Drive に保存する
  saveHtmlToDrive(articleHtml, CONFIG.SLUG, CONFIG.OUTPUT_FOLDER_ID);

  Logger.log("======= 完成HTML（先頭3000文字）=======");
  Logger.log(articleHtml.substring(0, 3000));
}




// =============================================================================
// STEP 1: docId 抽出
// =============================================================================

function extractDocId(url) {
  var match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error("有効な Google Docs URL ではありません: " + url);
  }
  return match[1];
}




// =============================================================================
// STEP 2: Google Docs → 生 HTML 取得
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

  var response = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error("HTML 取得失敗。ステータス: " + response.getResponseCode());
  }

  return response.getContentText();
}




// =============================================================================
// STEP 3: Google Docs HTML → semantic HTML パーサー
// =============================================================================
//
// 【処理フロー】
//   Phase 1 — ノイズ除去
//     body 抽出 → style/script 削除 → div/span/font ラッパー除去
//     → Google リダイレクト URL を元の URL に戻す
//
//   Phase 2 — ノード抽出
//     許可タグ（h2, h3, p, ul, ol, blockquote, img）だけを位置付きで収集
//     → 位置順にソート → 重複（ネスト）を除外して flat list を得る
//
//   Phase 3 — semantic HTML 再構築
//     各ノードを article-* クラス付き HTML に変換
//
function parseGoogleDoc(rawHtml) {

  // ── Phase 1: ノイズ除去 ────────────────────────────────────────
  var html = extractBodyContent(rawHtml);

  // style / script ブロックを削除する
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");

  // div・span・font は wrapper なので開始/終了タグだけ削除（中身は残す）
  html = html.replace(/<div[^>]*>/gi, "\n");
  html = html.replace(/<\/div>/gi, "\n");
  html = html.replace(/<span[^>]*>/gi, "");
  html = html.replace(/<\/span>/gi, "");
  html = html.replace(/<font[^>]*>/gi, "");
  html = html.replace(/<\/font>/gi, "");

  // table / hr / form 系は完全削除
  html = html.replace(/<table[\s\S]*?<\/table>/gi, "");
  html = html.replace(/<hr[^>]*\/?>/gi, "");

  // Google リダイレクト URL（href="https://www.google.com/url?q=...）を元の URL に変換
  html = decodeGoogleLinks(html);

  // ── Phase 2: 許可ノード抽出 ──────────────────────────────────
  var nodes = extractAllowedNodes(html);

  // ── Phase 3: semantic HTML 再構築 ───────────────────────────
  return renderSemanticHtml(nodes);
}


// <body>...</body> の中身だけを取り出す
function extractBodyContent(html) {
  var match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!match) {
    throw new Error("<body> タグが見つかりませんでした");
  }
  return match[1];
}


// Google のリダイレクト URL を元の URL に復元する
function decodeGoogleLinks(html) {
  return html.replace(
    /href="https?:\/\/www\.google\.com\/url\?q=([^&"]+)[^"]*"/gi,
    function(m, url) {
      try { return 'href="' + decodeURIComponent(url) + '"'; }
      catch(e) { return m; }
    }
  );
}




// =============================================================================
// Phase 2: 許可ノード抽出
// =============================================================================
//
// 許可タグをすべて正規表現で収集し、位置順にソートした後、
// 重複（= ネストしているノード）を除外して flat な配列を返す。
//
// 例: <blockquote><p>text</p></blockquote>
//   → blockquote（outer）と p（inner）が両方マッチするが、
//     outer の blockquote を採用し、inner の p はスキップする。
//
function extractAllowedNodes(html) {
  var allMatches = [];
  var m;

  // ── ブロック要素 (h2, h3, p, ul, ol, blockquote) ─────────────
  // ※ 遅延マッチ [\s\S]*? を使用。同じタグのネストは非対応（Google Docs では稀）
  var blockRe = /<(h2|h3|p|ul|ol|blockquote)([^>]*)>([\s\S]*?)<\/\1>/gi;
  blockRe.lastIndex = 0;
  while ((m = blockRe.exec(html)) !== null) {
    allMatches.push({
      index:   m.index,
      end:     m.index + m[0].length,
      tag:     m[1].toLowerCase(),
      attrs:   m[2],
      content: m[3]
    });
  }

  // ── img 要素 ─────────────────────────────────────────────────
  var imgRe = /<img([^>]*)>/gi;
  imgRe.lastIndex = 0;
  while ((m = imgRe.exec(html)) !== null) {
    var srcM = m[1].match(/src="([^"]*)"/i);
    var altM = m[1].match(/alt="([^"]*)"/i);
    allMatches.push({
      index: m.index,
      end:   m.index + m[0].length,
      tag:   "img",
      src:   srcM ? srcM[1] : "",
      alt:   altM ? altM[1] : ""
    });
  }

  // ── 位置順にソート ─────────────────────────────────────────
  allMatches.sort(function(a, b) { return a.index - b.index; });

  // ── 重複（ネスト）を除外する ──────────────────────────────
  // ネストしているノードは outer が先に登録されるため、
  // lastEnd より前に始まるノードはすべてスキップする
  var result = [];
  var lastEnd = -1;
  allMatches.forEach(function(node) {
    if (node.index >= lastEnd) {
      result.push(node);
      lastEnd = node.end;
    }
  });

  return result;
}




// =============================================================================
// Phase 3: semantic HTML 再構築
// =============================================================================

function renderSemanticHtml(nodes) {
  var output = "";
  nodes.forEach(function(node) {
    var rendered = renderNode(node);
    if (rendered) {
      output += rendered + "\n";
    }
  });
  return output.trim();
}


// ノードの種類に応じてレンダラーに振り分ける
function renderNode(node) {
  switch (node.tag) {
    case "h2":         return renderHeading("h2", "article-h2", node.content);
    case "h3":         return renderHeading("h3", "article-h3", node.content);
    case "p":          return renderParagraph(node.content);
    case "ul":         return renderList("ul", node.content);
    case "ol":         return renderList("ol", node.content);
    case "blockquote": return renderBlockquote(node.content);
    case "img":        return renderImage(node.src, node.alt);
    default:           return "";
  }
}


// h2 / h3 をレンダリングする
function renderHeading(tag, cssClass, content) {
  var text = cleanInlineContent(content).trim();
  if (!text) return "";
  return "<" + tag + " class=\"" + cssClass + " reveal\">" + text + "</" + tag + ">";
}


// p をレンダリングする
function renderParagraph(content) {
  var text = cleanInlineContent(content).trim();
  if (!text || text === "&nbsp;") return "";
  return "<p class=\"article-body reveal\">" + text + "</p>";
}


// ul / ol をレンダリングする（li の中の p を除去して平坦化する）
function renderList(tag, content) {
  var items = [];
  var liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  var m;

  while ((m = liRe.exec(content)) !== null) {
    var liContent = m[1];
    // li の中の <p>...</p> ラッパーを除去する（テキストは残す）
    liContent = liContent.replace(/<p[^>]*>/gi, "");
    liContent = liContent.replace(/<\/p>/gi, " ");
    var text = cleanInlineContent(liContent).trim();
    if (text) {
      items.push("  <li>" + text + "</li>");
    }
  }

  if (!items.length) return "";
  return "<" + tag + " class=\"reveal\">\n" + items.join("\n") + "\n</" + tag + ">";
}


// blockquote をレンダリングする
function renderBlockquote(content) {
  // 内部の <p> タグを除去してテキストを取り出す
  var text = content.replace(/<p[^>]*>/gi, "");
  text = text.replace(/<\/p>/gi, " ");
  text = cleanInlineContent(text).trim();
  if (!text) return "";
  return "<blockquote class=\"article-quote reveal\"><p>" + text + "</p></blockquote>";
}


// img をレンダリングする
function renderImage(src, alt) {
  if (!src) return "";
  var srcAttr = " src=\"" + src + "\"";
  var altAttr = alt ? " alt=\"" + alt + "\"" : "";
  return "<img class=\"article-image reveal\"" + srcAttr + altAttr + ">";
}


// インライン要素をクリーニングする
// strong / em / a はセマンティクスを保持し、その他の属性は除去する
function cleanInlineContent(html) {
  if (!html) return "";

  // 残っている span / font を除去する（テキストは残す）
  html = html.replace(/<span[^>]*>/gi, "");
  html = html.replace(/<\/span>/gi, "");
  html = html.replace(/<font[^>]*>/gi, "");
  html = html.replace(/<\/font>/gi, "");

  // strong / em / b / i / u → class/style 属性だけ除去してタグは残す
  html = html.replace(/<(strong|em|b|i|u)([^>]*)>/gi, function(m, tag) {
    return "<" + tag.toLowerCase() + ">";
  });

  // a タグ → href だけ残す
  html = html.replace(/<a([^>]*)>/gi, function(m, attrs) {
    var hm = attrs.match(/href="([^"]*)"/i);
    return hm ? "<a href=\"" + hm[1] + "\">" : "<a>";
  });

  // br タグを除去する
  html = html.replace(/<br\s*\/?>/gi, "");

  // 連続する空白・改行を1スペースにまとめる
  html = html.replace(/\s+/g, " ");

  return html.trim();
}




// =============================================================================
// STEP 4: テンプレート読み込み
// =============================================================================

function loadTemplate(fileId) {
  return DriveApp.getFileById(fileId).getBlob().getDataAsString("UTF-8");
}




// =============================================================================
// STEP 5: プレースホルダ差し込み + パス修正
// =============================================================================
//
// article-template.html のプレースホルダ:
//   {{PAGE_TITLE}}           → <title> タグのタイトル
//   {{TITLE}}                → <h1>・パンくずのタイトル（複数箇所）
//   {{CATEGORY}}             → カテゴリ名（複数箇所）
//   {{DATE}}                 → 公開日
//   {{LEAD}}                 → リード文
//   <!-- ARTICLE_CONTENT --> → パース済み本文 HTML
//
function buildArticleHtml(template, articleContent, config) {
  var html = template;

  // split + join で全出現箇所を置換する（replace はデフォルトで最初の1件のみ）
  html = html.split("{{PAGE_TITLE}}").join(config.TITLE);
  html = html.split("{{TITLE}}").join(config.TITLE);
  html = html.split("{{CATEGORY}}").join(config.CATEGORY);
  html = html.split("{{DATE}}").join(config.DATE);
  html = html.split("{{LEAD}}").join(config.LEAD);

  // 本文を差し込む
  html = html.replace("<!-- ARTICLE_CONTENT -->", articleContent);

  // articles/ サブディレクトリ用にパスを修正する
  html = fixPaths(html);

  return html;
}


// root 相対パスを articles/ サブディレクトリ用の ../ に変換する
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
// STEP 6: Drive に保存
// =============================================================================

function saveHtmlToDrive(html, slug, folderId) {
  var fileName = slug + ".html";
  var blob = Utilities.newBlob(html, "text/html; charset=utf-8", fileName);

  var file;
  if (folderId && folderId !== "") {
    file = DriveApp.getFolderById(folderId).createFile(blob);
  } else {
    file = DriveApp.createFile(blob);
  }

  Logger.log("STEP6 完了: Drive に保存しました");
  Logger.log("ファイル名: " + fileName);
  Logger.log("Drive URL: " + file.getUrl());

  return file;
}
