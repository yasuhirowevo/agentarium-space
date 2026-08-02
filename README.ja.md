# Agentarium Space

[English](./README.md) | **日本語**

ローカルで動いている **Claude Code** と **Codex CLI** のセッションを、
夜の星図の下で発光する生き物たちとして眺めるデスクトップアプリ（Windows / macOS）。

プロジェクトごとの「潮だまり」の中を、セッションの光る orb がゆっくり漂います。
ツール実行中は水面に波紋が広がり、考え中はハローがゆっくり呼吸し、
放置されると目を閉じて縁に沈みます。sub-agent は親の周りを回る小さな光として現れ、
仕事を終えると粒子になって散ります。

## Windows へのインストール

ビルド済み配布版は Windows 10 以降の x64 PC に対応します。
[GitHub Releases](https://github.com/yasuhirowevo/agentarium-space/releases) から
`agentarium-space-<version>-windows-x64.exe` をダウンロードして実行してください。
インストール不要の portable アプリのため、管理者権限・Node.js・npm・pnpm は不要です。

初期のWindows版は未署名のため、Microsoft SmartScreen の警告が表示される場合があります。
公式のリリースページから取得したファイルであることを確認してから続行してください。
更新時は GitHub Releases から新しい EXE をダウンロードし、古いファイルと置き換えます。

## macOS へのインストール

ビルド済み配布版は macOS 12 Monterey 以降の Apple シリコンと Intel Mac に対応します。
Electron を同梱しているため Node.js は不要です。最初のリリースと Homebrew Tap の更新が
公開された後は、次のコマンドでインストールできます。

```bash
brew install --cask yasuhirowevo/tap/agentarium-space
open -a "Agentarium Space"
```

Homebrew Cask での配布に Apple Developer Program は不要です。任意の Developer ID 署名・公証を
行っていないリリースは、無料の ad-hoc 署名だけで配布されます。`brew install` は完了しますが、
初回起動時に macOS の Gatekeeper がアプリを止める場合があります。公式リリースから取得したことを
確認したうえで一度起動し、**システム設定 → プライバシーとセキュリティ → このまま開く**を選んでください。
詳しくは [Apple の案内](https://support.apple.com/102445)を参照してください。Cask が quarantine を
自動解除することはありません。

以後のリリースへ更新する場合:

```bash
brew upgrade --cask yasuhirowevo/tap/agentarium-space
```

## ソースからの開発・実行

Node.js 22.13 以降が必要です。再現可能な開発環境には lockfile を使う pnpm を推奨します。
追加のパッケージマネージャーを用意せずに試す場合は、Node.js に同梱されている npm を使えます。

### npm（手軽に試す）

```bash
npm install
npm start        # Electron アプリとして起動
npm run web      # ブラウザで見る場合（表示された起動ごとの URL を開く）
npm run scan     # 現在の状態を JSON で出力（デバッグ用）
npm test         # テストを実行
```

### pnpm（lockfile どおりに使う）

このリポジトリでは `pnpm-lock.yaml` で依存バージョンを固定しています。

```bash
pnpm install --frozen-lockfile
pnpm start        # Electron アプリとして起動
pnpm run web      # ブラウザで見る場合（表示された起動ごとの URL を開く）
pnpm run scan     # 現在の状態を JSON で出力（デバッグ用）
pnpm test         # テストを実行
```

環境変数:

- `AGENTARIUM_PORT` — 待ち受けポート（デフォルト 41414）
- `AGENTARIUM_WINDOW_MIN` — 表示対象とする活動ウィンドウ（分、デフォルト 60）
- `AGENTARIUM_DELEGATION_DIR` — 異種エージェント委譲sidecarの保存先（任意・絶対パス）
- `AGENTARIUM_DEBUG` — 1 でパーサ等のデバッグログを stderr に出力

## 見かた

- **リング（潮だまり）** = プロジェクト。中央上にプロジェクト名と git ブランチ
- **orb** = セッション。暖色 = Claude Code / 寒色 = Codex
- **波紋 + 明るいコア** = ツール実行中。ツール名と対象はネームプレートの状態行に表示
- **ハローの呼吸** = 考え中 / **中輝度** = 入力待ち / **減光 + 目を閉じる** = アイドル
- **周回する小さな光** = sub-agent（親の周りを回り、完了すると粒子バーストで消える。親との関係線上を光が流れていたら稼働中）
- **暖色から寒色へ伸びる細い線** = Claude Code ↔ Codex skill の委譲。両セッションは通常サイズの独立orbのまま、実行中だけ呼び出し元から委譲先へ光が流れる
- **ネームプレート** = 各 orb の下にセッション名と「いまやっていること」（ツール名: 対象・経過時間）。新しい発話は引出線付きの注記として表示
- **ヘッダ HUD** = 現在時刻 / 状態別カウント / SYNC（最終受信からの経過）/ イベント毎分スパークライン / LINK 状態
- **SECTOR 表記** = プロジェクトの潮だまり（`SECTOR-A ─ 名前 ─ N UNITS`）。全高の LIVE STREAM モジュールには直近の行動が流れる
- orb をクリックすると計器パネル（エージェントツリー / ステータスタイムライン / cwd / ブランチ / ライブストリーム）。10 分超の長時間実行は `LONG RUN`、切断時は `LINK LOST` 表示

## 仕組み

- `~/.claude/projects/**/*.jsonl` と `~/.codex/sessions/**/*.jsonl` を**読み取り専用**で tail し、
  セッション状態を組み立てて WebSocket で UI に配信するだけ
- 任意のClaude/Codex wrapper連携は、ランダムなlink ID・子のsource/session ID・status・時刻だけを短命なローカルsidecarへ保存する。prompt・cwd・回答は保存せず、sidecarが不正または利用不能なら無視する
- 起動後のアプリは完全にローカルで動作します。待ち受けは 127.0.0.1 のみで、外部への通信や
  telemetry 送信は行いません。Homebrew によるインストール・更新時にはネットワークを使用しますが、
  アプリ自身に自動更新機能はありません。起動ごとのランダムトークンと HTTP Host / WS Origin
  検証により、ブラウザ上の他サイトからのクロスオリジン読み取りも遮断します
- ウィンドウ非表示中は描画を完全停止。`prefers-reduced-motion` 対応

## 注意

- 本ツールは**非公式**です。Anthropic / OpenAI とは無関係で、各 CLI のログ形式（内部仕様）に
  依存するため、CLI のバージョンアップで表示が壊れることがあります（未知の形式は無視して動き続けます）
- 利用者自身が読み取り権限を持つセッションログだけを対象にしてください
- `run_in_background` で起動された Claude Code の sub-agent は追跡できない場合があります（既知の限界）
- コンテキスト使用率のうち Claude 分の窓サイズは、既定の 200000 トークンを用いた近似です

## License

[MIT](./LICENSE)
