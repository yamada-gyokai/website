const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const https = require('https');

const app = express();

// サイト本体（Git 作業ディレクトリ）は infra の親＝リポジトリルート
const REPO_ROOT = path.join(__dirname, '..');
const REQUESTS_DIR = path.join(__dirname, 'requests');
const LATEST_DIFF = path.join(REQUESTS_DIR, 'latest_diff.txt');
const LATEST_REQUEST = path.join(REQUESTS_DIR, 'latest_request.txt');
const LATEST_COMMIT = path.join(REQUESTS_DIR, 'latest_commit.txt');

fs.mkdirSync(REQUESTS_DIR, { recursive: true });

/** シェル埋め込み用（パスに空白・引用符があっても安全に） */
function shellQuote(p) {
  return `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const ALLOWED_USERS = ['U02EUD5BTB2'];

function validateDiff(diffText) {
  if (typeof diffText !== 'string' || !diffText.trim()) {
    return { ok: false, error: 'diff が空です' };
  }
  const gitDiffCount = diffText.split('\n').filter((line) => line.startsWith('diff --git')).length;
  if (gitDiffCount === 0) {
    return { ok: false, error: 'diff形式が不正です' };
  }
  if (gitDiffCount !== 1) {
    return { ok: false, error: '複数ファイルの変更は禁止されています' };
  }
  const diffGitLine = diffText.split('\n').find((line) => line.startsWith('diff --git')) || '';
  const m = diffGitLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
  const pathA = m ? m[1] : '';
  const pathB = m ? m[2] : '';
  function isAllowedPath(p) {
    return /^[^/]+\.html$/.test(p);
  }

  if (!isAllowedPath(pathA) || !isAllowedPath(pathB)) {
    return { ok: false, error: '許可されていないディレクトリの変更です' };
  }
  const deleteCount = diffText
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  if (deleteCount > 50) {
    return { ok: false, error: '削除行数が多すぎます' };
  }
  try {
    execSync('git apply --check -', {
      cwd: REPO_ROOT,
      input: diffText,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    return { ok: true };
  } catch (e) {
    const stderr = e.stderr != null ? String(e.stderr) : '';
    return { ok: false, error: stderr.trim() || e.message };
  }
}

function extractSummaryFromClaudeOutput(text) {
  if (typeof text !== 'string') {
    return '';
  }
  const m = text.match(/\[SUMMARY\]\s*([\s\S]*?)\s*\[\/SUMMARY\]/i);
  return m ? m[1].trim() : '';
}

function extractCommitMessage(text) {
  if (typeof text !== 'string') {
    return '';
  }
  const m = text.match(/\[COMMIT\]\s*([\s\S]*?)\s*\[\/COMMIT\]/i);
  return m ? m[1].trim().split('\n')[0].trim() : '';
}

/** /ai ok 用。latest_commit.txt が無い・空のときのみ fallback */
function readCommitMessageForOk() {
  try {
    const msg = fs.readFileSync(LATEST_COMMIT, 'utf-8').trim();
    if (msg) {
      return msg;
    }
  } catch {
    // fall through
  }
  return 'AI変更';
}

function extractDiffFromClaudeOutput(text) {
  if (typeof text !== 'string') {
    return '';
  }
  const marker = 'diff --git';
  const idx = text.indexOf(marker);
  if (idx !== -1) {
    return text.slice(idx);
  }
  return text;
}

/**
 * Slack リクエスト署名を検証する。
 * ngrok 公開時に第三者が /webhook へ POST するのを防ぐため、
 * SLACK_SIGNING_SECRET で HMAC を再計算し X-Slack-Signature と照合する。
 * 署名計算にはパース前の rawBody が必須（body-parser 後の req.body では不可）。
 */
function verifySlackSignature(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error('SLACK_SIGNING_SECRET が未設定です');
    return false;
  }

  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  const rawBody = req.rawBody;

  if (!signature || !timestamp || !rawBody) {
    return false;
  }

  // リプレイ攻撃対策: 5分以上古いタイムスタンプは拒否
  const requestTs = Number.parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(requestTs) || Math.abs(now - requestTs) > 60 * 5) {
    return false;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const sigBaseString = `v0:${timestamp}:${body}`;
  const expected =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBaseString).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

// verify で rawBody を保持（Slack 署名は application/x-www-form-urlencoded の生ボディで計算される）
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  })
);
app.use(express.json());

app.post('/webhook', (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(403).send('Invalid Slack signature');
  }

  if (!ALLOWED_USERS.includes(req.body.user_id)) {
    return res.status(403).send('Forbidden');
  }

  const text = req.body.text || '';
  const responseUrl = req.body.response_url;

  console.log('受信:', text, req.body.user_id);

  if (text.trim().toLowerCase() === 'help') {
    res.json({
      response_type: 'in_channel',
      text: `
利用可能コマンド：

1. 修正依頼（通常入力）
2. apply（差分適用）
3. ok（保存＋公開）
4. log（履歴確認）
5. rollback <id>（巻き戻し）
6. help（この一覧）

例：
/ai トップページの文言を変更
/ai apply
/ai ok
`
    });
    return;
  }

  // =========================
  // OK（commit処理）
  // =========================
  if (text.trim().toLowerCase() === 'ok') {
    const commitMsg = readCommitMessageForOk();
    exec(
      `cd ${shellQuote(REPO_ROOT)} && git diff --quiet || (git add . && git commit -m ${shellQuote(commitMsg)} && git push origin main)`,
      (err, stdout, stderr) => {
        if (err) {
          console.error('commit/pushエラー:', err);
          res.json({
            response_type: 'in_channel',
            text: '変更の保存またはpushに失敗しました'
          });
          return;
        }

        res.json({
          response_type: 'in_channel',
          text: '変更を保存して公開しました'
        });
      }
    );

    return;
  }

  // =========================
  // log（直近コミット）
  // =========================
  if (text.trim().toLowerCase() === 'log') {
    exec(`cd ${shellQuote(REPO_ROOT)} && git log --oneline -5`, (err, stdout, stderr) => {
      if (err) {
        console.error('git log エラー:', err);
        res.json({
          response_type: 'in_channel',
          text: 'git log の取得に失敗しました'
        });
        return;
      }

      res.json({
        response_type: 'in_channel',
        text: stdout.trim() || '(履歴なし)'
      });
    });

    return;
  }

  // =========================
  // rollback（指定コミットへ）
  // =========================
  const rbParts = text.trim().split(/\s+/).filter(Boolean);
  if (rbParts[0] && rbParts[0].toLowerCase() === 'rollback') {
    const commitId = rbParts[1];
    if (!commitId) {
      res.json({
        response_type: 'in_channel',
        text: 'エラー: commit id を指定してください（rollback と commit id を入力）'
      });
      return;
    }

    if (!/^[0-9a-f]{7,40}$/i.test(commitId)) {
      res.json({
        response_type: 'in_channel',
        text: 'エラー: commit id の形式が不正です'
      });
      return;
    }

    exec(`cd ${shellQuote(REPO_ROOT)} && git tag backup-$(date +%s)`, (tagErr) => {
      if (tagErr) {
        res.json({
          response_type: 'in_channel',
          text: 'バックアップ作成に失敗したためrollbackを中止しました'
        });
        return;
      }

      exec(
        `cd ${shellQuote(REPO_ROOT)} && git revert --no-commit ${commitId} && git commit -m "revert: ${commitId}" && git push origin main`,
        (err, stdout, stderr) => {
          if (err) {
            exec(`cd ${shellQuote(REPO_ROOT)} && git revert --abort`, () => {});

            res.json({
              response_type: 'in_channel',
              text: `rollbackに失敗しました:\n${stderr || err.message}`
            });
            return;
          }

          res.json({
            response_type: 'in_channel',
            text: `指定のコミットにロールバックしました: ${commitId}`
          });

          exec(`cd ${shellQuote(REPO_ROOT)} && git log --oneline -1`, (e2, stdout2) => {
            console.log('現在のHEAD:', stdout2);
          });
        }
      );
    });

    return;
  }

  // =========================
  // apply（差分適用）
  // =========================
  if (text.trim().toLowerCase() === 'apply') {
    let diff;
    try {
      diff = fs.readFileSync(LATEST_DIFF, 'utf-8');
    } catch {
      res.json({
        response_type: 'in_channel',
        text: 'diff ファイルがありません'
      });
      return;
    }

    const validation = validateDiff(diff);
    if (!validation.ok) {
      res.json({
        response_type: 'in_channel',
        text: validation.error
      });
      return;
    }

    exec(
      `cd ${shellQuote(REPO_ROOT)} && git apply --reject --whitespace=fix ${shellQuote(LATEST_DIFF)}`,
      (err) => {
        if (err) {
          console.error('git apply エラー:', err);
          return;
        }
        const hasReject = fs.readdirSync(REPO_ROOT).some((f) => f.endsWith('.rej'));
        if (hasReject) {
          const files = fs.readdirSync(REPO_ROOT);
          files
            .filter((f) => f.endsWith('.rej'))
            .forEach((f) => fs.unlinkSync(`${REPO_ROOT}/${f}`));

          res.json({
            response_type: 'in_channel',
            text: '差分の一部が適用できませんでした（.rej発生）'
          });
          return;
        }
        console.log('差分を適用しました');
        res.json({
          response_type: 'in_channel',
          text: '差分を適用しました'
        });
      }
    );

    return;
  }

  // =========================
  // 通常AI処理
  // =========================

  // 差分・commit message リセット
  fs.writeFileSync(LATEST_DIFF, '');
  fs.writeFileSync(LATEST_COMMIT, '');

  // 即時レスポンス（Slackエラー防止）
  res.json({
    response_type: 'ephemeral',
    text: '処理を開始しました'
  });

  // Claude用プロンプト
  const content = `
あなたはHTML/CSSを編集するエンジニアです。

以下の指示に従って修正してください。

【指示】
${text}

【制約】
・ファイルは直接編集しない
・必ず差分（before/after）で提示する
・指示が曖昧または意味をなさない場合は、変更せず理由を説明する
・変更対象は指示内容に含まれる範囲に限定する

【出力形式】（厳守・この順序のみ）
[SUMMARY]
ユーザーの指示をどう解釈したか、何をどのファイルのどこへ変更するかを3〜5文で簡潔に書く
[/SUMMARY]

[COMMIT]
feat: 変更内容（50文字程度・feat/fix/style/refactor 等の接頭辞推奨）
[/COMMIT]

（空行1行）

diff --git から始まる unified diff

【diffの制約】
・複数のdiffは禁止（必ず1つ）
・差分は必ず前後3行以上の文脈を含める
・単一行だけの差分は禁止
・@@ の範囲は最低でも5行以上含める
・[SUMMARY][COMMIT]ブロック以外に説明文・補足・コメントは禁止
`;

  fs.writeFileSync(LATEST_REQUEST, content);
  console.log('リクエスト保存完了');

  // Claude実行（REPO_ROOT で作業し、プロンプトは infra/requests から読む）
  exec(
    `cd ${shellQuote(REPO_ROOT)} && claude -p "$(cat ${shellQuote(LATEST_REQUEST)})"`,
    (err, stdout) => {
      if (err) {
        console.error('Claudeエラー:', err);
        return;
      }

      console.log('Claude出力:\n', stdout);

      const summary = extractSummaryFromClaudeOutput(stdout);
      const commitMessage = extractCommitMessage(stdout);
      const diffPayload = extractDiffFromClaudeOutput(stdout);
      try {
        fs.writeFileSync(LATEST_DIFF, diffPayload);
        fs.writeFileSync(LATEST_COMMIT, commitMessage);
        console.log('差分ファイル更新完了');
        console.log('commit message:', commitMessage || '(未設定→ok時は AI変更)');
        console.log('差分:\n', diffPayload);
      } catch (e) {
        console.error('差分/commit message書き込みエラー:', e);
      }

      // Slackへ理解要約を返却（diffは latest_diff.txt のみ。apply 前の認識合わせ用）
      if (responseUrl) {
        const parsedUrl = new URL(responseUrl);
        const slackText = summary
          ? `*理解確認*\n${summary}\n\n問題なければ \`/ai apply\` を実行してください。`
          : '理解要約を取得できませんでした。内容を確認のうえ、必要なら再度 /ai を実行してください。';

        const postData = JSON.stringify({
          response_type: 'in_channel',
          text: slackText
        });

        const slackOptions = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const reqPost = https.request(slackOptions, (res) => {
          console.log('Slack返信ステータス:', res.statusCode);
        });

        reqPost.on('error', (e) => {
          console.error('Slack返信エラー:', e);
        });

        reqPost.write(postData);
        reqPost.end();
      }
    }
  );
});

app.post('/ai/apply', (req, res) => {
  let diff;
  try {
    diff = fs.readFileSync(LATEST_DIFF, 'utf-8');
  } catch {
    return res.status(400).json({ error: 'diff ファイルがありません' });
  }

  const validation = validateDiff(diff);
  if (!validation.ok) {
    console.error('validateDiff エラー:', validation.error);
    return res.status(400).json({ error: validation.error });
  }

  exec(
    `cd ${shellQuote(REPO_ROOT)} && git apply --reject --whitespace=fix ${shellQuote(LATEST_DIFF)}`,
    (err, stdout, stderr) => {
      if (err) {
        console.error('git apply エラー:', err);
        res.status(500).json({ error: stderr || String(err) });
        return;
      }
      const hasReject = fs.readdirSync(REPO_ROOT).some((f) => f.endsWith('.rej'));
      if (hasReject) {
        const files = fs.readdirSync(REPO_ROOT);
        files
          .filter((f) => f.endsWith('.rej'))
          .forEach((f) => fs.unlinkSync(`${REPO_ROOT}/${f}`));

        res.status(500).json({ error: '差分の一部が適用できませんでした（.rej発生）' });
        return;
      }
      res.json({ ok: true });
    }
  );
});

app.listen(3000, () => {
  console.log('サーバー起動: http://localhost:3000');
});
