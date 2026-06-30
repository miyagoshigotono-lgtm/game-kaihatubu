/**
 * ダンジョン開発スタジオ — 受付GAS（Webアプリ）
 *
 * 役割：ブラウザ（ページ）から「付箋＝指示 / 評価 / 差し入れ」を受け取り、
 *       GitHubリポジトリのJSONファイルに追記するだけの“受付係”。
 *       GitHubトークンはこのGASのスクリプトプロパティに保管し、ブラウザには一切渡さない。
 *
 * ───────────────────────────────────────────────
 * 【セットアップ手順】
 * 1) script.google.com で新規プロジェクトを作成し、このコードを貼り付ける。
 * 2) 左メニュー「プロジェクトの設定」→「スクリプト プロパティ」に次を追加：
 *      GITHUB_TOKEN : repo 権限を持つ Personal Access Token（classic の repo スコープ）
 *      REPO_OWNER   : miyagoshigotono-lgtm
 *      REPO_NAME    : game-kaihatubu
 *      BRANCH       : main
 *      PASSPHRASE   : あいことば（ひらがなOK。ページ初回入力と同じ文字列）
 * 3) 「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」
 *      ・実行するユーザー：自分
 *      ・アクセスできるユーザー：全員
 *    でデプロイし、表示された「ウェブアプリのURL」を index.html の GAS_ENDPOINT に貼る。
 * ───────────────────────────────────────────────
 *
 * 保存先ファイル：
 *   note   → instructions.json （指示の履歴）
 *   rating → ratings.json      （評価の履歴）
 *   treat  → treats.json       （差し入れの履歴）
 * いずれも配列に追記する（夜のミーティングがこれを読む）。
 */

var TYPE_TO_FILE = {
  note:   'instructions.json',
  rating: 'ratings.json',
  treat:  'treats.json'
};

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();

    // 合言葉チェック
    var expected = String(props.getProperty('PASSPHRASE') || '');
    if (expected && String(body.pass || '') !== expected) {
      return json_({ ok: false, error: 'bad pass' });
    }

    var type = String(body.type || '');
    var file = TYPE_TO_FILE[type];
    if (!file) return json_({ ok: false, error: 'bad type' });

    var entry = body.payload || {};
    entry.type = type;
    entry.at = nowJst_();

    appendToRepoJson_(file, entry);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 動作確認用（ブラウザでURLを開くと alive が返る）
function doGet() {
  return json_({ ok: true, msg: 'studio reception is alive' });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowJst_() {
  var d = new Date(Date.now() + 9 * 3600 * 1000);
  function p(n) { return ('0' + n).slice(-2); }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
         ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

/**
 * GitHubリポジトリ内のJSON配列ファイルに1件追記する。
 * 競合(409)時は最大3回まで取得→追記→PUTをやり直す。
 */
function appendToRepoJson_(path, entry) {
  var props  = PropertiesService.getScriptProperties();
  var token  = props.getProperty('GITHUB_TOKEN');
  var owner  = props.getProperty('REPO_OWNER');
  var repo   = props.getProperty('REPO_NAME');
  var branch = props.getProperty('BRANCH') || 'main';
  if (!token || !owner || !repo) throw new Error('スクリプトプロパティ未設定（GITHUB_TOKEN/REPO_OWNER/REPO_NAME）');

  var api = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;
  var headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'studio-gas'
  };

  for (var attempt = 0; attempt < 3; attempt++) {
    // 既存ファイル取得
    var sha = null, arr = [];
    var getRes = UrlFetchApp.fetch(api + '?ref=' + encodeURIComponent(branch), {
      headers: headers, muteHttpExceptions: true
    });
    if (getRes.getResponseCode() === 200) {
      var j = JSON.parse(getRes.getContentText());
      sha = j.sha;
      var decoded = Utilities.newBlob(Utilities.base64Decode(String(j.content || '').replace(/\n/g, ''))).getDataAsString('UTF-8');
      try { arr = JSON.parse(decoded); } catch (e) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
    }

    arr.push(entry);
    if (arr.length > 500) arr = arr.slice(-500); // 上限

    var content = Utilities.base64Encode(Utilities.newBlob(JSON.stringify(arr, null, 2) + '\n').getBytes());
    var put = { message: 'studio: ' + path + ' に追記 [skip ci]', content: content, branch: branch };
    if (sha) put.sha = sha;

    var putRes = UrlFetchApp.fetch(api, {
      method: 'put', contentType: 'application/json',
      headers: headers, payload: JSON.stringify(put), muteHttpExceptions: true
    });
    var code = putRes.getResponseCode();
    if (code < 300) return;                 // 成功
    if (code === 409) { Utilities.sleep(400); continue; } // 競合→やり直し
    throw new Error('GitHub PUT failed: ' + code + ' ' + putRes.getContentText());
  }
  throw new Error('GitHub PUT failed: 競合が続いたため中断');
}
