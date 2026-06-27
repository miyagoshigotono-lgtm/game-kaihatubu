# 破壊神のダンジョンメイカー 自律開発システム v5.0

GitHub Actions + GitHub Pages で動く、ゲームを毎日自律的に育てるシステムです。
朝礼（10:15）で方針を決め、ランチ（13:00）で `game.html` を全文生成して上書きします。

## ファイル構成

```
/
├── index.html                 ポータル（ゲーム表示・手動実行・ログ閲覧）
├── game.html                  ゲーム本体（ウィンドウ全体に自動フィット）
├── morning_directive.json     朝礼の結論（初期値入り）
├── logs.json                  開発ログ（初期は空配列）
├── README.md                  このファイル
└── .github/workflows/
    ├── morning.yml            朝礼ワークフロー（JST 10:15 / 手動）
    └── lunch.yml              ランチワークフロー（JST 13:00 / 手動）
└── scripts/
    ├── morning.js             分析・評価・方針決定（game.htmlは変更しない）
    └── lunch.js               実装・QA・全文上書き
```

## セットアップ手順

### 1. リポジトリ作成
このフォルダ一式をリポジトリの直下に置いて push します（デフォルトブランチは `main`）。

### 2. Gemini APIキーを Secrets に登録
リポジトリの **Settings → Secrets and variables → Actions → New repository secret**
- Name: `GEMINI_API_KEY`
- Value: あなたの Gemini APIキー

### 3. GitHub Pages を有効化
**Settings → Pages → Build and deployment → Source: Deploy from a branch**
- Branch: `main` / `/ (root)`
公開URL（例: `https://ユーザー名.github.io/dungeon-maker/`）がポータルになります。

### 4. Actions の書き込み権限
**Settings → Actions → General → Workflow permissions** を
**「Read and write permissions」** に設定（Botがコミットするため）。

### 5. index.html の定数を書き換え
`index.html` 冒頭の2つを自分のリポジトリに合わせます。
```js
const REPO_OWNER = 'YOUR_GITHUB_USERNAME';
const REPO_NAME  = 'dungeon-maker';
```

### 6. 手動実行用トークン（任意）
ポータルの「朝礼を実行 / ランチを実行」ボタンを使う場合のみ必要です。
- GitHub の **Settings → Developer settings → Personal access tokens** でトークンを発行
- 必要権限: **Actions（read and write）**（Fine-grained なら対象リポジトリの Actions: Read and write）
- 初回ボタンクリック時に入力 → ブラウザの localStorage に保存されます

> セキュリティ注意: このトークンは「ワークフローを起動できる」権限です。共有PCや公開端末では使わないでください。スケジュール実行（10:15 / 13:00）だけならトークンは不要です。

## 動作の流れ

1. **朝礼** `morning.js`：game.html・logs.json・前回directiveを読み、司令塔→評価→企画の3エージェントが `morning_directive.json` を生成（game.htmlは不変）。
2. **ランチ** `lunch.js`：directiveに従い、設計→プログラマー（全文生成）→QAの3エージェントが動く。QA（AIの"PASS"完全一致）＋静的検証＋出力切れガードを全て通過したときだけ `game.html` を上書き。失敗時は最大2回再生成し、それでもダメなら game.html を変更せず失敗ログだけ残す。

## 設計上の注意（既知のリスク）

- **全文上書き方式**：`gemini-3.1-flash-lite` の出力上限は約64Kトークン。game.htmlが育つほど一度に吐ききれず途中で切れるリスクがあります。`lunch.js` の静的検証に「`</html>`で終わっていなければ却下」する出力切れガードを入れてあります。切れが頻発したら、生成方式の見直し（差分マージ復活 or 上位モデルでの生成）を検討してください。
- **QAの"PASS"判定**：仕様通り完全一致ですが、前後の空白・改行のみは許容（`trim`）しています。
