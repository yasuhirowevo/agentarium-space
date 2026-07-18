# Agentarium Space — 設計書

ローカルの Claude Code / Codex CLI のセッションログ（JSONL）を**読み取り専用**で監視し、
セッションと sub-agent を「星図の下で発光する生き物たちの生態系」として鳥瞰表示するデスクトップアプリ。
本書は**仕様の正典**。デザイン判断の「なぜ」と拡張時の判断基準は [PHILOSOPHY.md](./PHILOSOPHY.md) を参照。

## 公開識別とローカル接続認証（v2.14 — Agentarium Space）

- 公開上のプロダクト名は **Agentarium Space**、リポジトリ・package slug は
  `agentarium-space` とする。**Lumen Bay** は UI v2 コンセプトのコードネームとしてのみ扱う
- 既存利用者との互換性を優先し、`AGENTARIUM_*` 環境変数と `agentarium.*` localStorage key は変更しない
- サーバー起動ごとに `randomBytes(32)` でランダムトークンを生成し、プロセスのメモリ内だけに保持する。
  ファイル・環境変数・localStorage・Cookie には保存しない
- UI の入口は `http://127.0.0.1:<port>/<token>/`。HTTP は正しい token path 配下の
  `GET` / `HEAD` のみ許可し、token 無し・誤 token・前方一致だけの token は 403 とする。
  `/<token>` は `/<token>/` へリダイレクトする
- CSS / JavaScript は token path を保つ相対 URL で取得する。WebSocket endpoint は
  `ws://127.0.0.1:<port>/<token>/ws` とする
- WebSocket upgrade は token path に加えて従来の HTTP Host / WS Origin を検証する。
  Origin ヘッダ無しの非ブラウザクライアントも、正しい token path がある場合だけ許可する
- HTTP 応答には `Referrer-Policy: no-referrer` と `Cache-Control: no-store` を付け、token URL を
  外部参照元やキャッシュへ残さない。再起動すると旧 URL は失効する
- Electron は `startServer()` が返す token 付き URL を直接開く。`pnpm run web` は同 URL を stdout に
  一度表示し、利用者は表示された URL をブラウザで開く。固定の token 無し URLは案内しない
- 回帰検証は `node:test` で行い、HTTP 資産・WS snapshot の成功系に加えて token 無し／誤 token、
  外部 Host／Origin、パストラバーサル、再起動後の旧 token を拒否することを確認する

## macOS 配布と Homebrew Cask（v2.15 — Homebrew Cask 配布）

- macOS 版は Electron ランタイムを同梱した `Agentarium Space.app` として配布する。利用者側の
  Node.js / npm / pnpm は不要とし、ソースを利用者環境で組み立てる Formula は提供しない。
  対象は macOS 12 Monterey 以降の arm64 / x64 とし、Windows の配布成果物は v2.15 の対象外とする
- GitHub Release のタグは `package.json` の version と一致する `v<version>` とし、成果物は
  `agentarium-space-<version>-macos-arm64.zip` と
  `agentarium-space-<version>-macos-x64.zip` の 2 つを正典とする。zip 直下には
  `Agentarium Space.app` だけを置く。DMG は直接ダウンロード用の副成果物として同時生成してよい
- Homebrew Cask / Tap と Developer ID 未署名アプリのビルド・配布には Apple Developer Program を
  必要条件としない。標準のリリース処理は無料の ad-hoc 署名だけを施した zip を生成し、
  GitHub Release と Cask から配布できること。ad-hoc 署名は Apple Silicon の実行要件を満たすためのもので、
  Developer ID による配布元の証明や Gatekeeper の警告回避にはならない
- Developer ID Application による署名と Apple notarization / staple は任意の追加設定とする。必要な資格情報が
  一式そろっている場合だけ署名済みリリースを生成し、一部だけ設定されている場合は曖昧な成果物を作らず失敗させる
- Developer ID 未署名アプリは `brew install` できるが、macOS の Gatekeeper により初回起動が止められる場合がある。
  その場合の公式な「このまま開く」手順を README に示す。Cask やアプリから quarantine を自動解除しない
- ローカル検証用には ad-hoc 署名の unpacked app を `dist/` 配下へ生成できる。公開用 zip も同じコードと
  パッケージ設定から生成し、公開前に packaged smoke test を通す
- 配布アイコンは UI に登場する寒色の orb 1 体だけを高解像度化して使う。文字・ロゴ・星図・
  セッション名・ローカルパスなど、キャラクター以外の画面要素は含めない
- Homebrew は `yasuhirowevo/homebrew-tap` の Cask `agentarium-space` から提供し、正式な導入コマンドを
  `brew install --cask yasuhirowevo/tap/agentarium-space` とする。Cask は CPU architecture ごとの
  zip と SHA-256 を固定し、`Agentarium Space.app` を `/Applications` へ配置する
- リリース処理はテスト → arm64 / x64 ビルド → （設定済みの場合のみ署名・notarization）→
  GitHub Release 公開 → Cask 更新 PR 作成の順に行う。Tap の `main` へ直接 push せず、
  version・URL・両 checksum をレビューできる PR を経由する
- 自動更新通信は追加しない。更新は GitHub Release と `brew upgrade` に委ね、実行時の
  127.0.0.1 限定・外部送信ゼロ・ログ読み取り専用という既存契約を変えない

## Windows portable 配布（v2.16 — Windows x64）

- v2.15 の macOS / Homebrew Cask 配布はそのまま維持する。Windows 版は Electron ランタイムを
  同梱した、インストール不要の `Agentarium Space.exe` として配布する。初期対象は Windows 10 以降の
  x64 とし、利用者側の Node.js / npm / pnpm は不要とする。Windows arm64・インストーラー形式は
  後続の対象とする
- GitHub Release のタグは引き続き `v<version>` とし、v2.15 の macOS zip 2 つに加え、
  `agentarium-space-<version>-windows-x64.exe` を同じ Release に掲載する。Homebrew Cask は macOS
  成果物だけを参照し、Windows EXE は Cask や Tap の checksum 更新対象に含めない
- Windows 成果物は `portable` target とする。管理者権限やインストールは要求せず、更新は GitHub Release
  から利用者が手動で行う。実行時の自動更新通信・外部送信・telemetry は追加しない
- Windows のコード署名は配布の必須条件にしない。標準リリースは未署名の portable EXE を生成できること。
  Microsoft SmartScreen が警告する可能性は README に明記し、Authenticode 署名は将来の任意設定として扱う
- PR と `main` 更新時の CI、およびタグリリースのビルドは Windows runner で実行する。公開前に
  `win-unpacked` の `Agentarium Space.exe` を空の `USERPROFILE` で起動し、ASAR・ローカル HTTP 配信・
  Electron ウィンドウの readiness・継続実行を smoke test で確認する。生成した portable EXE も起動し、
  展開後のアプリが loopback server を待ち受け続けることを確認する
- 配布アイコンは v2.15 と同じ、UI の寒色 orb 単体を使う。セッション情報を含む画面全体のスクリーンショットは
  含めない

## 原則

- **読み取り専用**: ログファイルへの書き込み・改変・削除は一切しない
- **完全ローカル**: ネットワークは 127.0.0.1 のみ（UI 配信 + WebSocket）。外部送信・telemetry ゼロ
- **商標配慮**: Anthropic / OpenAI の商標・ロゴ・アセットを使わない。"Claude Code" / "Codex" はデータソース名としてのテキスト表記のみ
- **耐バージョン性**: ログ形式は非公開の内部仕様。未知のレコード型・JSON.parse 失敗行は黙って無視（デバッグログのみ）し、絶対にクラッシュしない

## 技術スタック

- Node.js 22+ / plain JavaScript (ESM, `"type": "module"`) / UI のトランスパイルなし・フレームワークなし
- dependencies: `chokidar`（ファイル監視）, `ws`（WebSocket）
- devDependencies: `electron`, `electron-builder`（macOS / Windows 配布パッケージ生成）
- UI: 素の HTML/CSS/JS + inline SVG

## プロセス構成

```
┌ Electron main (electron/main.js) ── pnpm start
│   └ src/server.js を import して起動 → BrowserWindow で token 付き loopback URL を開く
└ src/server.js 単体起動 ─────────── pnpm run web （ブラウザで閲覧）
     ├ HTTP: ui/ を静的配信（127.0.0.1 bind のみ）
     ├ WS:   状態 snapshot を push
     └ watchers → state store
```

- PORT: 環境変数 `AGENTARIUM_PORT`、デフォルト `41414`
- `pnpm run scan`: watch せず一回だけスキャンして状態 JSON を stdout 出力（検証用 CLI）

## ディレクトリ構成

```
agentarium-space/
  package.json
  electron-builder.yml   macOS zip / Windows portable EXE の配布設定
  build/                 アイコンと任意署名で使う最小限の entitlement
  electron/main.js        Electron エントリ（BrowserWindow, contextIsolation:true, nodeIntegration:false, sandbox:true, preload なし）
  electron/network-policy.js  Renderer の通信先を起動中の loopback server に限定する純粋関数
  scripts/                macOS / Windows packaged smoke test と Homebrew Cask 生成
  src/
    server.js             起動エントリ: watchers 起動 + HTTP/WS 配信
    state.js              セッション状態モデル（純粋関数中心・watchers から独立してテスト可能）
    scan.js               検証用 CLI（初期スキャンのみ → JSON 出力 → exit）
    tail.js               JSONL 増分読み取り（offset 管理・部分行バッファ）
    watchers/claude.js    ~/.claude/projects 監視・パース
    watchers/codex.js     ~/.codex/sessions 監視・パース
  ui/
    index.html
    office.js             WS 受信 → オフィス描画
    office.css
```

## データソース仕様（2026-07-12 実機確認済み）

### Claude Code

- パス: `~/.claude/projects/<project-slug>/<sessionId>.jsonl`（slug はプロジェクト絶対パスの記号を `-` に置換したもの。例 `C--Users-alice-repositories-sample-app`）
- `<sessionId>/` という**サブディレクトリ**（tool-results 等）も並存するが**監視対象外**。`*.jsonl` 直下のみ見る
- 1 行 1 JSON。主な `type`: `user` / `assistant` / `queue-operation` / `ai-title` / `custom-title` / `last-prompt` / `pr-link` / `mode` / `summary` / `system`（他にもあり得る。未知は無視）
- 共通フィールド（user/assistant 等に付く）: `timestamp`(ISO8601) / `sessionId` / `cwd`(Windows 形式 `C:\\...`) / `gitBranch` / `version` / `isSidechain`(bool)
- `assistant`: `message.content[]` に `{type:"text"|"thinking"|"tool_use"}`。`tool_use = {id, name, input}`
- `user`: 実ユーザー発話のほか、`message.content[]` に `{type:"tool_result", tool_use_id}` を含む「ツール完了」レコードが来る
- **sub-agent**: `name === "Agent"`（旧バージョン互換で `"Task"` も）の tool_use。`input: {description, subagent_type, run_in_background, prompt}`。対応する `tool_result` が来るまで「稼働中 sub-agent」とみなす
  - 制約: `run_in_background: true` の agent は tool_result が早期に返るため追跡できない場合がある（v1 の既知の限界として README に記載）
- **タイトル**: `{"type":"custom-title","customTitle":"..."}` > `{"type":"ai-title","aiTitle":"..."}`（custom 優先・同種は後勝ち）
- `isSidechain: true` のレコードは sub-agent 側の発話。メインセッションの status・lastActivity には影響させず、`lastSidechainActivity` のみ更新する（表示ウィンドウ判定にだけ使う。main が waiting なのに sidechain の追記で thinking 表示になる誤判定を防ぐ）

実レコード例（先頭部分）:

```json
{"type":"ai-title","aiTitle":"ダッシュボード表示の調整","sessionId":"00000000-..."}
{"type":"custom-title","customTitle":"Sample app dashboard tuning","sessionId":"00000000-..."}
// assistant レコード内: "type":"tool_use","id":"toolu_example...","name":"Grep"
// Agent tool_use input: {"description":"関連仕様の確認","subagent_type":"general-purpose","run_in_background":false,"prompt":"..."}
```

### Codex

- パス: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
- 1 行 1 JSON: `{timestamp, type, payload}`
- `type === "session_meta"`（先頭行）: `payload = {id, timestamp, cwd, originator, cli_version, source, ...}`
  - `payload.source.subagent.thread_spawn = {parent_thread_id, depth, agent_path}` が**あれば sub-agent セッション** → 親 rollout（`payload.id === parent_thread_id`）のデスクにぶら下げる。親が表示対象外なら単独表示
  - fork 情報 `forked_from_id` / `parent_thread_id` が payload 直下に来る形も確認済み（subagent source が無ければ通常セッション扱い）
- `type === "turn_context"`: `payload = {turn_id, cwd, workspace_roots, ...}`（cwd の最新値として利用）
- `type === "event_msg"`: `payload.type` ∈ `task_started` / `task_complete` / `agent_message` / `user_message` / `token_count` / `sub_agent_activity {agent_thread_id, agent_path, kind:"started"|...}` / `patch_apply_end` / 他
- `type === "response_item"`: `payload.type` ∈ `function_call {name, arguments, call_id?}` / `function_call_output` / `custom_tool_call` / `custom_tool_call_output` / `reasoning` / `message` / 他
- ステータス材料: `task_started`（ターン開始）〜 `task_complete`（ターン終了）。ターン中の直近 `function_call` / `custom_tool_call` の `name` を「現在の作業」として表示

## 増分読み取り（tail.js）

- ファイルごとに `{offset, 部分行バッファ}` を保持。chokidar の `add`/`change` で offset から読み足す（`fs.createReadStream(path, {start: offset})`）
- 行区切りは `\n`。最終行が未完でも部分行バッファに保持し次回結合。`JSON.parse` 失敗行は捨てる
- **初回発見時（巨大ファイル対策）**: サイズが 256KB 超なら「先頭 128KB + 末尾 256KB」だけパースし、offset をファイル末尾へ。256KB 以下なら全量パース
  - 先頭 128KB は**メタ抽出専用**（session_meta / タイトル / cwd / parentId。Codex の session_meta 1 行は実測最大 42KB 程度あるため 8KB では不足）。**pending ツールや status 判定には使わない**（中間の脱落により result と突き合わせられず pending が固着するため）
  - 既知の限界（許容）: 末尾 256KB 内に改行が 1 つもない巨大単一行はそのレコードを取りこぼす（以降は自己回復する）。末尾領域の開始が偶然レコード境界だった場合も先頭 1 レコードを捨てる。いずれも影響は最大 1 レコードで、完全対処は過剰設計と判断
  - 末尾 256KB の読み始めは次の改行の直後から（壊れた部分行を捨てる）
- ファイル縮小（truncate）検知時は offset を 0 にリセットして読み直し
- 対象: 起動時スキャンで **mtime が 24 時間以内**の `.jsonl` のみ。それより古いファイルは無視（watch で change が来たら拾う）
- **セッションが表示ウィンドウ超えで prune されるときは、対応する tail 状態（offset / buffer）も破棄する**。長時間稼働でのリーク防止と、再活性化時に初回読み直しとなることで先頭のメタ（session_meta / タイトル / parentId）を再取得できる効果を兼ねる
- chokidar には `ignored`（および必要なら `depth`）を指定し、watch 対象を実際に読む形に限定する: Claude はプロジェクトディレクトリ直下の `*.jsonl` のみ（`<sessionId>/` サブディレクトリは watch しない）、Codex は `YYYY/MM/DD` 階層とその直下の `*.jsonl` のみ。全ツリー監視による FD・メモリ消費と起動遅延を防ぐ

## 状態モデル（state.js）

```js
session = {
  id: string,               // Claude: sessionId / Codex: rollout の session id
  key: string,              // ログファイルパス由来の一意キー。UI の DOM 要素対応にはこちらを使う
                            // （resume 等で同一 sessionId が複数ファイルに現れても衝突しない）
  source: 'claude' | 'codex',
  cwd: string,              // 正規化（\ → /）
  projectName: string,      // cwd の basename
  title: string,            // custom-title > ai-title > 最初のユーザー発話先頭 40 文字 > id 先頭 8 桁
  status: 'thinking' | 'tool' | 'waiting' | 'idle',
  activity: string | null,  // 直近の pending ツール名（例 "Bash", "Read", "shell"）
  activityDetail: string | null, // 実行中ツールの対象の短い説明（最大 48 文字・改行除去。v2.2）
  lastMessage: string | null,    // 直近の AI 発話の冒頭（最大 60 文字・改行→スペース。v2.2）
  lastMessageAt: number | null,  // 上記の epoch ms（v2.2）
  lastActivity: number,     // epoch ms（最後に有効レコードを読んだ時刻ではなく、レコードの timestamp）
  gitBranch: string | null,
  parentId: string | null,  // Codex sub-agent rollout のとき親 session id
  subAgents: [{ id, label, status: 'running'|'done', startedAt }],
  recentEvents: [string],   // 人間可読の直近イベント最大 10 件（例 "23:41 Bash"）
}
```

### status 判定（現在時刻 now を引数に取る純粋関数で計算）

1. `now - lastActivity > 15min` → `idle`（最優先）。ただし **pending ツールが残っている間は idle 閾値を ACTIVE_WINDOW まで延長**する（Codex の長時間 exec 等は完了まで新規レコードが出ないため、15 分で 💤 に落とすと実際に働いているセッションを居眠り表示にしてしまう。クラッシュ残骸の pending は最大ウィンドウ経過で消える）
   - レコード timestamp は取り込み時に `now + 60s` を上限にクランプする（未来 timestamp による status 固着・prune 不能を防ぐ）
2. pending ツール（Claude: tool_result 未着の tool_use / Codex: output 未着の function_call・custom_tool_call）あり → `tool`
3. Claude: 直近が assistant テキストのみ かつ `now - lastActivity < 10s` → `thinking`（ストリーミング途中の可能性）、`>= 10s` → `waiting`。直近が user 発話 / tool_result → `thinking`
4. Codex: `task_started` 後 `task_complete` 未着 → `thinking`（pending call があれば 2 で `tool`）。`task_complete` 後 → `waiting`
5. 表示対象: `now - max(lastActivity, lastSidechainActivity) <= ACTIVE_WINDOW`（env `AGENTARIUM_WINDOW_MIN`、デフォルト 60 分）のセッションのみ。超えたら state からも削除（tail 状態も同時に破棄）

### sub-agent

- Claude: pending の `Agent`/`Task` tool_use → `{id: tool_use.id, label: input.description || subagent_type, status:'running'}`。tool_result 到着で `done`（60 秒後にリストから除去）
- Codex: sub-agent rollout ファイル自体が session として入る（`parentId` 付き）。UI 側で親デスクの横に nest 表示。`sub_agent_activity` イベントは補助情報（v1 では未使用でよい）

## 配信（server.js）

- HTTP: `ui/` を静的配信。`127.0.0.1` に bind。Content-Type は拡張子ベース最小実装。パストラバーサル防止（正規化後に ui/ 配下チェック）
- **HTTP は Host ヘッダの hostname が `127.0.0.1` / `localhost` 以外なら 403**（DNS rebinding 対策）
- WS（同一サーバーの upgrade）: 接続時 + 状態変化時（1 秒デバウンス）+ 15 秒毎ハートビートで全量 snapshot 送信
- **WS は接続時に token path と Origin ヘッダを検証**: token は v2.14 の起動時生成値との完全一致、
  Origin は `http://127.0.0.1:<port>` / `http://localhost:<port>` のみ許可する。Origin ヘッダ無しは
  正しい token path がある場合だけ許可。それ以外は拒否する
  - `{type:'snapshot', at: <epoch ms>, sessions: [session...]}`（セッション数は高々数十なので全量で十分）

## UI（v2 コードネーム: Lumen Bay / ui/）— 全面刷新

> v1（部屋 + デスク + blob のバーチャルオフィス）は、activity 順ソートによるレイアウト再配置の頻発と
> shake アニメーションが目に負担で、表現も既視感があったため全面刷新した。
> DOM カードによるレイアウトを廃止し、**Canvas 1 枚に描く発光生態系**として再設計する。

### コンセプト

真っ暗な入り江を上から眺めると、発光するいきもの（セッション）がプロジェクトごとの
「潮だまり（pool）」の中をゆっくり漂っている。ツールを実行すると水面に波紋が広がり、
sub-agent の小さな光が親の周りを回る。アートインスタレーションのように常時滑らかに
動き続けるが、うるさくない。**眺めていて心地よいことを最優先**にする。

### 画面構成

- 背景: 全面 Canvas。深いインディゴ→黒のラジアルグラデーション + ごく薄い静的な粒子
- ヘッダ（DOM・最小限）: 左に小さくアプリ名（letter-spacing 広めの英字スモールキャップス）、右に稼働数 / sub-agent 数 / 接続ドット。罫線・カードなし、背景に溶ける
- オペレーションパネル（DOM・**常設ドック型**。v2.4 で常時表示に変更）:
  - 画面の左右どちらかに固定幅（~320px）で常駐し、**Canvas はパネルを除いた残り領域**にレイアウトする（オーバーレイ・スクリム廃止。下の要素を隠さない）
  - 未選択時は**全体ビュー**: 全セクターのエージェントツリー（プロジェクト → セッション → 子、状態色ドット）+ 全体ライブストリーム（相対時刻・毎秒更新）
  - orb クリックでそのセッションの計器ビュー（SOURCE/BRANCH/CWD/LAST SIGNAL・エージェントツリー・ステータスタイムライン・ライブストリーム）に切替。× または Esc で全体ビューへ戻る（パネル自体は閉じない）
  - パネルヘッダの ⇄ ボタンで**左右ドックを切替**。選択は localStorage（`agentarium.panelSide`、既定 'right'）に永続化。切替時の Canvas 再レイアウトは既存の lerp 遷移で滑らかに行う
  - Renderer/Interaction は window サイズではなく **Canvas コンテナの実サイズ**基準にする（リサイズ・ドック切替の両方で正しく追従）
- スクリーンリーダー向けに visually-hidden のセッション一覧（ul）を snapshot ごとに同期
- WS 切断時はヘッダの接続ドットを「接続待ち」表示 + 3 秒毎再接続

### エンティティと配置（安定性が最優先）

- **Pool（プロジェクト）**: 細い発光リング + 内側にごく薄いグロー。中央上にプロジェクト名（白 70%）と branch（白 40%・小さく）
  - 配置: プロジェクト key の**アルファベット順**で phyllotaxis（ひまわり螺旋）に決定論的配置。半径は sqrt(セッション数) スケール。**activity 順の並び替え禁止**
  - 出現/消滅・位置/半径の変化はすべて lerp（指数減衰、時定数 ~0.6s）で滑らかに遷移
- **Orb（セッション）**: 発光する球。コア + ハロー（半径 2.5 倍のグロー）。小さな顔（点の目 2 つ + 口）を持ち、4〜9 秒ごとにランダムで瞬き
  - claude = 暖色（コーラル→アンバー）/ codex = 寒色（アイスシアン）
  - 自分の pool 内を**key シードの sum-of-sines による周期オフセット + 指数減衰の追従**でゆっくり徘徊（見た目が滑らかであれば厳密な noise steering は不要）。テレポート禁止。新規は pool 縁からフェードイン、退場はフェードアウトしつつ沈む
  - 同一性は `session.key`。orb の位置・シードを key で引き継ぐ
- **Satellite（Codex の子セッション / parentId 持ち）**: 親 orb の楕円軌道をゆっくり公転する 60% サイズ orb。クリック可能。親不在時は通常 orb
- **Spark（Claude の subAgents[]）**: 親 orb を周回する小さな光点（r≈4px）。直近 12 位置の残像トレイル。done で小さな粒子バーストして消える

### status → 表現（shake 禁止・絵文字廃止。低周波・発光ベース）

- `tool`: コア輝度最大。2.5 秒ごとに波紋（拡大して消える細いリング）を放つ。orb 上部に activity 名の小ラベル（白 60%）
- `thinking`: ハローが 2.8 秒周期 sine で 1.0→1.15 に膨縮。微細な光点 2〜3 個が周囲から吸い込まれる
- `waiting`: 中輝度で漂いを最小化。ラベルなし
- `idle`: 輝度 30%・目を閉じ・pool 縁へゆっくり沈む。8 秒ごとに一度だけ淡く明滅
- `lastActivity` 更新の瞬間に波紋を 1 回打つ（イベントの可視化）

### 可読性レイヤ（v2.1 — 「誰が何やってるか」を常時読めるようにする）

> 初版 Lumen Bay は美観に寄りすぎ、hover しないと個体識別できなかった。
> 「AI が働くのを上から眺める楽しさ」= 名前の見える個体 + いま起きた行動の可視化、を常時レイヤとして足す。

- **orb 同士の衝突分離**: pool 内の通常 orb は毎フレーム、最終ターゲット位置（wander 適用後）に対して決定論的な pairwise separation を行い重ねない。ネームプレートを考慮した**楕円距離**（水平 min ≈ 96px・垂直 min ≈ 54px）を最小間隔とする。lerp 追従はそのままなので動きは滑らかに保たれる
- **pool の大きさはメンバー数基準**: targetRadius を「全員がネームプレート込みで余裕を持って収まる」面積から算出（目安 r = 90 + sqrt(count) × 52、上限は min(260, 画面比)）。入りきらない場合のみ従来のクランプで妥協
- **ネームプレート常時表示**: すべての通常 orb の下（ハローの外、y + radius×1.9 付近)に title を常時表示（白 78%・最大幅 ~120px で省略）。その直下に状態行（tool: ツール名 / thinking: 考え中 / waiting: ひと休み。idle は名前のみで状態行省略）を白 45% の小さい字で。既存の「tool 時のみ上部ラベル」は廃止（状態行に統合）
- **イベントポップ**: snapshot 適用時に recentEvents の末尾が増えた orb から、新イベントのラベル（例 `Bash` / `Read done`）が小さな文字で上方向へ ~1.4 秒かけて浮かび上がりフェードする（1 orb 1 snapshot につき 1 件まで・同時最大 ~8 件・reduced-motion 時は無効）。「いま何かした」が画面の動きとして見える
- **親子の関係線**: satellite と親 orb の間に細い線（source 色 10〜18% 不透明度）を描き、従属関係を一目で分かるようにする
- **ハロー縮小**: 2.5 倍 → 2.0 倍にし、発光の塊ではなく「個体」として読めるようにする
- satellite / spark はネームプレート省略（サイズと関係線で従属を表現）。satellite は hover で title 表示（既存どおり）

### 実況レイヤ（v2.2 — 作業の「中身」を見せる）

コア側の抽出ルール（watchers。pendingTools は {name, detail} で保持）:

- Claude（tool_use.input から）: Bash → `command` の 1 行目 ~40 文字 / Read・Edit・Write・NotebookEdit → `basename(file_path)` / Grep・Glob → `pattern`（引用符付き）/ WebFetch → URL ホスト名 / WebSearch → `query` / Agent・Task → `description` / その他 → null
- Claude 発話: assistant レコード（sidechain 除く）の text 冒頭を `lastMessage` に（thinking は使わない）
- Codex: function_call / custom_tool_call の `arguments` JSON から `command` / `cmd` / `path` / `query` らしきキーを best-effort で 1 つ抽出（parse 失敗は null）。event_msg `agent_message` の冒頭を `lastMessage` に
- recentEvents のラベルも `名前: 対象` 形式に強化（例 `Edit: office.js`）

UI 側:

1. **実況表示**: ネームプレート状態行を `ツール名: 対象` に（fitText ~140px）
2. **セリフ吹き出し**: `lastMessageAt` が前回 snapshot より進んだ orb に、尾つきの小さな丸角吹き出し（ダークガラス・白 80%）を ~6 秒表示してフェード。同時最大 4 件・同一 orb は上書き。reduced-motion 時はアニメなしのカット切替
3. **道具マイクロアイコン**: 状態行の左に ~10px の canvas 描画アイコン。bash/exec/shell→ターミナル / read→本 / edit・write・apply_patch→ペン / grep・glob・search→虫眼鏡 / webfetch・web_search→地球 / agent・task→旗 / その他→歯車
4. **経過時間バッジ**: 状態が 30 秒以上継続していたら状態行末尾に `・N分`（now - lastActivity ベース、1 分未満は `・30秒+`）
5. **アクティビティフィード**: 画面左下に直近イベント 5 件のスタック（`HH:MM projectName → Edit: office.js`、新着で上に積み古い順にフェードアウト。白 55%・10px・インタラクションなし）

制約: 追加フィールドは null 許容で後方互換。吹き出し・フィードの文字列は fillText / textContent のみ（HTML 挿入禁止）。

### Mission Control レイヤ（v2.3 — 近未来管制室 FUI）

> コンセプト: 「かわいい生き物たち × 近未来管制室」。orb の愛嬌はそのまま、周辺 UI を SF アニメの
> オペレータールーム風に。**実データ駆動で嘘の計器は作らない**。

階層構造の可視化:

- **パネル内エージェントツリー**: 選択セッションを根に、codex 子セッション（parentId 逆引き・再帰）と Claude subAgents をインデントツリー表示（状態色ドット + title + 状態ラベル、罫線 └─）。既存「サブエージェント」節を置き換える
- **データフロー演出**: 稼働中（thinking/tool）の satellite と親を結ぶ線上を小さな光点 2〜3 個が親→子方向に流れる。reduced-motion 時は静的線のみ

サイドパネル = ライブオペレーションビュー:

- メタ情報を計器風 2 カラム（`SOURCE` `BRANCH` `CWD` `LAST SIGNAL`＝lastActivity からの相対時刻・毎秒更新。ラベルは等幅大文字 letter-spacing 広め白 40%、値は白 80%）
- **ライブストリーム**: recentEvents を新しい順・相対時刻（毎秒更新）付きで表示。新着行は 1 回だけ淡くパルス
- **ステータスタイムライン**: クライアント側で観測した状態遷移を (t, status) リングバッファ（最大 30 分）に蓄積し、status 色の横棒（右端が現在）で描画
- 装飾: 四隅コーナーブラケット・上下の細いシアンルール・ごく薄い走査線テクスチャ（CSS gradient）

画面全体の FUI:

- **ヘッダ HUD**: 左にアプリ名 + 現在時刻（HH:MM:SS 毎秒更新）。右に状態別カウント（tool/thinking/waiting/idle の色ドット + 数）、SYNC インジケータ（最終 snapshot からの経過秒。>20s で琥珀）、イベント/分ミニスパークライン（幅 ~80px・直近 15 分・クライアント集計）
- **背景レーダー**: 画面中心の極座標グリッド（同心円 3〜4 本 + 放射線、白 2〜3%）と 1 周 ~24 秒の回転スイープ（白 1.5%）。reduced-motion で停止
- **コーナーブラケット**: 画面四隅に細い L 字（白 8%）
- **pool のセクター化**: ラベルを `SECTOR‑A`（key ソート順の連番）+ プロジェクト名にし、リングに 12 個の目盛りティック（白 6%）、名前の右に `N UNITS` バッジ
- **フィードのコンソール化**: v2.2 の左下フィードを等幅・`▸` プレフィックス・新着 1 文字ずつタイプイン（~250ms・reduced-motion 時は即時）に
- **アラート**: 同一ツール pending 10 分超 → 状態行を琥珀 (#ffb454 系) にし `LONG RUN` 点滅付記 / WS 切断中 → ヘッダを赤 (#ff5c5c 系) `LINK LOST` + 画面上端に細い赤ライン

制約: 常時アニメーションの追加は「スイープ・データフロー・タイプイン」の 3 系統のみ。既存の 30fps キャップ・visibility 停止・reduced-motion 構造に乗せる。ダミー数値・意味のない点滅を作らない。

### コンソール・コンポジション（v2.6 — レイアウトの洗練）

> パネル常設化（v2.4）後の全体レイアウト見直し。一枚板の全高ドロワーをやめ、
> 「管制卓のウィジェット群が夜の海に浮いている」コンポジションにする。

全体レイアウト:

- ヘッダ HUD を**全幅**に通し、その下を「**モジュール列（~300px・左ドックが既定）** + Canvas 領域」の flex 行に。localStorage `agentarium.panelSide` の**既定値は 'left'**（⇄ の右切替は残すがオプション扱い。左 = 情報レール、右 = 開けた海面の視線動線）
- モジュール列は**上下・外側 12px のインセット**を持ち、画面の上下いっぱいまで伸ばさない。ページ背景のグラデーションを列の背後に連続させ、モジュールの隙間から覗かせる
- Canvas 領域はモジュール列の予約幅を除いた範囲（orb・pool を隠さない原則は維持）
- レーダー・スイープ・四隅ブラケットは Canvas 領域内限定
- **アクティビティフィードは Canvas 領域の右下に移動**（テキストは左揃えのままブロックごと右下配置）

モジュールスタック（旧パネルの再構成。隙間 10px。各カード: 角丸 10px・半透明ダークガラス・ヘアラインボーダー・小さなコーナーブラケット・英字スモールキャップスのモジュールヘッダ）:

1. **FOCUS モジュール**（可変高）: 未選択時 = 全体統計（セクター数 / セッション数 / sub-agent 数 / 直近 15 分のイベント総数 + 状態別内訳バー）。選択時 = 既存のセッション計器。× / Esc で未選択へ
2. **AGENT TREE モジュール**（最大 45%・内部スクロール）: 既存のセクター別ツリー（ミニタイムライン付き・選択ハイライト）
3. **LIVE STREAM モジュール**（flex-grow・内部スクロール）: 既存のグローバル/セッションストリーム

- ⇄ と ×（選択解除）は列最上部の小さなツールレールへ移動
- スクロールバーは細いカスタムスタイル（幅 6px・角丸・白 12%）。走査線は各モジュール内に薄く維持
- 既存機能（ツリー・ストリーム・計器・タイムライン・切替）の削除禁止。再配置のみ

### 情報密度レイヤ（v2.5 — 常時表示情報を増やす）

> 思想: 「クリックしないと見えない」を減らし、画面が常に実データで満ちている状態にする。

コア側（公開フィールド追加・null 許容）:

- `contextUsedTokens` / `contextWindowTokens` — Claude: assistant の `message.usage`（input + cache_creation + cache_read）を used に、window は既定 200000 の定数（近似である旨コメント）。Codex: `token_count` の `info.last_token_usage.input_tokens` を used に（`cached_input_tokens` は input_tokens の部分集合なので加算しない。v2.11 で修正）、`task_started` の `model_context_window` を window に
- 大ファイル初回のメタ専用適用でも token 系は更新してよい（pending/status に影響しない表示メタデータ）

UI 側:

1. **コンテキストリング**: orb 半径 +4px に細い円弧（線幅 1.2px・12 時起点・時計回り = 使用率）。〜60% は source 色 35%、60〜80% は白 45%、80% 超は琥珀。used が null なら非表示。状態行末尾に `CTX 42%`（白 40%）を付記
   - **フォールバック（v2.6 修正）**: `used > window` のとき（Claude の近似窓 200000 が実モデルの窓より小さい場合に発生）は嘘の 100% を出さず、リングを非表示にして `CTX 523k` の実トークン数表示に切り替える
2. **最新発話の常時 1 行**: 非 idle の orb のネームプレート 3 行目に `lastMessage` 先頭 ~26 文字（白 35%・9px）を常時表示。吹き出し（v2.2）は出現演出として併存
3. **セクター統計行**: pool ラベルの 3 行目に `N ACTIVE · M EV/MIN · LAST HH:MM`（ACTIVE = tool + thinking 数 / EV/MIN = pool 単位のイベント毎分・クライアント集計 / LAST = pool 内最新 lastActivity。白 40%・9px）
4. **ツリー行ミニタイムライン**: パネル（全体ビュー・セッションビュー両方）のセッション行右端に、クライアント観測のステータス履歴を 48×6px の色帯で常時表示

制約: 実データ駆動・null 安全。README の注意に Claude の window 既定値が近似である旨を 1 行追記。

### デュアルレール（v2.8 — モジュールの左右分散）

> v2.6 の 1 カラム 3 モジュールは各モジュールの縦領域が 1/3 になり窮屈だった。
> 役割で左右に分け、Canvas を中央の主画面とする管制卓構図にする。

- **左カラム（~300px）**: FOCUS（可変高・概況 / 選択時は計器）+ AGENT TREE（flex-grow・内部スクロール）
- **右カラム（~280px）**: LIVE STREAM を全高で（内部スクロール・タイプイン演出は維持）
- **Canvas 内右下のアクティビティティッカーは廃止**（右カラムの LIVE STREAM が常時ログの役割を担い、二重表示を避ける）
- ⇄ ボタンは「左右カラムの入替」に意味変更（localStorage `agentarium.panelSide` を流用: 'left' = FOCUS/TREE が左・既定）
- 各カードの意匠（ガラス・ヘアライン・コーナーブラケット・スモールキャップスヘッダ・上下 12px インセット）は維持
- Canvas 領域は両カラムを除いた中央。リサイズ・入替時の再レイアウトは既存の lerp 遷移

### プラネタリウム背景とツールレール簡素化（v2.9 — 星図世界観への意匠統一）

> プラネタリウム系の名称・世界観に合わせ、背景の語彙を「管制レーダー」から「星図」へ揃える。
> v2.3 の背景レーダー（回転スイープ・放射スポーク）は本節で**置き換え**る。

背景（Canvas 領域）:

- 回転スイープと放射スポークを**廃止**
- **天球グリッド**: 緩やかに湾曲した赤経・赤緯風の細線（白 2%・静的）
- **軌道弧**: 画面を横切る大きな楕円弧 2〜3 本（白 3%・静的・決定論的配置）
- **星屑の強化**: 既存 specks に加え、明るめの星を数個（十字の微かな光条つき）。ゆっくりした瞬き（数秒周期・reduced-motion では静的）
- **流れ星**: 30〜90 秒に 1 回、短い光跡が流れて消える（控えめ・同時 1 個まで・reduced-motion 無効）
- 四隅コーナーブラケットは維持（コンソール枠）

ツールレール:

- ⇄（左右入替）ボタンを**削除**し、panelSide 設定（localStorage 読み書き・切替ロジック）ごと撤去（左固定・YAGNI）
- ×（選択解除）ボタンを**削除**。代替: セッション選択中は FOCUS モジュールヘッダに「← 全体」の戻りリンクを表示（textContent のボタン）。Esc・選択中 orb の再クリックでも戻れる（既存挙動維持）
- ツールレール自体が空になる場合はツールレールごと削除してよい

### データリッチネス（v2.7 — さらに常時表示する実データを増やす）

コア側（公開フィールド追加・null 許容）:

- `model` — Claude: assistant の `message.model`（後勝ち）/ Codex: turn_context の `model`（無ければ null）
- `writeAccess: 'write' | 'read' | null` — Codex: turn_context の `sandbox_policy` が write を含めば 'write'、read-only なら 'read'。Claude は null
- `approvalPolicy` — Codex: turn_context の `approval_policy`
- `originator` — Codex: session_meta の `originator` / Claude: `version`（CLI バージョン）を流用
- `outputTokensTotal` — 各応答の output_tokens を累積（Claude: usage.output_tokens / Codex: token_count の last_token_usage.output_tokens をイベントごとに加算）
- `startedAt` — 最初に観測したレコードの timestamp（メタ専用適用の先頭領域を含む最小値）
- `toolCounts`（上位 3 件 [{name, count}]）+ `toolCallsTotal` — ツール呼び出しの名前別累積

UI 側（Canvas への追加は最小限・パネル/HUD に厚く）:

- Canvas: 状態行を `CTX 42% · OUT 12k` に拡張（null は省略）。`writeAccess === 'write'` の orb は title 左に小さな琥珀 ▲ マーカー
- FOCUS（選択時）: MODEL / ACCESS（WRITE=琥珀・READ）/ APPROVAL / ORIGIN / UPTIME（毎秒更新）/ OUT TOKENS / TOP TOOLS（`Bash×42 Edit×17 Read×9`）を計器グリッドに追加
- FOCUS（全体ビュー）: フリート統計 — モデル別セッション数・WRITE 権限数・最多稼働セクター・累計 OUT トークン・累計ツールコール
- AGENT TREE 行: ミニタイムラインの左に `OUT 12k` と UPTIME（`2h04m`）を白 35% の小さな字で
- HUD: 右端に `TOTAL OUT 1.2M`（表示中セッションの合計）

制約: 実データ駆動・null 安全。Canvas のクラッタ化禁止（上記 2 点以外を orb 周りに足さない）。

### 惑星系レイヤ（v2.10 — sub-agent の所属可視化と fork メタ耐性）

> Codex（Codex Desktop 0.144.2 で実機確認）は sub-agent の rollout に、自分の session_meta に加えて
> **fork 元（親スレッド）の session_meta を 2 レコード目として埋め込む**。無条件適用だと
> `session.id` / `parentId` が親の値で上書き破壊され、衛星表現が全く発動しない（2026-07-14 発覚）。
> 本節はそのデータ修正と、「どの orb がどの親に属すか」を星図の語彙で常時読めるようにする表現追加。

コア側（watchers/codex.js + state.js）:

- **session_meta の受理条件**: ファイル名の rollout uuid（`rollout-<ts>-<uuid>.jsonl`）と `payload.id` が
  一致する session_meta だけを適用する。不一致（= fork 元の親 meta 埋め込み）は**レコードごと無視**
  （applyRichFields の originator 等も適用しない）。ファイル名から uuid が取れない場合は
  「最初に受理した session_meta の id と一致するもののみ適用」にフォールバック（first-wins）
- applyRecord / applyMetaRecord の両方に同じ受理条件を適用する
- **nickname 公開フィールド追加**（null 許容）: session_meta の
  `source.subagent.thread_spawn.agent_nickname`（例 `"Hypatia"`）を `session.nickname` として公開

UI 側（ui/office.js）:

1. **軌道環**: satellite が公転する楕円軌道そのもの（中心 = 親 orb・半径 = 既存の orbit 計算と同一・
   縦横比 0.58）を細線（白 3.5%・線幅 1px）で描く。同一親で実際に使われている軌道半径ごとに
   1 本（現行の交互 2 半径なら最大 2 本）。pool リングより上・orb より下のレイヤ。
   親に lerp 追従するが形は静的なので reduced-motion でも表示してよい
2. **ファミリー増光**: 親 orb またはその satellite の hover / 選択中、その家族
   （親 + 全 satellite + 関係線 + 軌道環）を連動して増光する
   （関係線 10–18% → 約 40% / 軌道環 3.5% → 約 10% / 各 orb のハローをわずかに増光）。
   遷移は既存の expLerp（時定数 ~0.25s）。非 hover 時は従来の静けさに戻る
3. **衛星ミニネームプレート**: satellite の下に通常ネームプレートの 60% スケールで
   `◦ nickname`（nickname が null なら title 先頭）を 1 行だけ常時表示（白 60%・最大幅 ~80px で省略）。
   状態行・CTX 等は付けない（クラッタ回避）。v2.1 の「satellite はネームプレート省略」は本節で改訂

制約: 実データ駆動・null 安全・決定論。連星バッジ等、orb 周りへのこれ以上の常時要素追加はしない。

### 観賞品質レイヤ（v2.11 — 畳み込み・呼称・計器精度・密集耐性）

> 「眺めて楽しめる・癒される」の総仕上げ。ストリームの反復ノイズ、id のままの呼称、
> 二重計上された CTX、密集時の名札衝突という 4 種の「観賞を妨げる摩擦」を取り除く。

コア側:

1. **CTX used の二重計上修正（watchers/codex.js）**: `last_token_usage` の `cached_input_tokens` は
   `input_tokens` の部分集合（実データで `total_tokens = input + output` を確認済み）。
   used は **`input_tokens` のみ**とする（finite でなければ更新しない）。
   これにより codex セッションの `CTX 400k` 生値フォールバックが本来の `CTX 17%` 等の比率表示に戻る
2. **title 導出の改善（state.js）**:
   - `setFirstUserPrompt` は、値がボイラープレート（`The following is the ` で始まる
     埋め込みコンテキスト定型文）の場合**保存しない**（後続の実プロンプトが title になれる first-wins を維持）
   - `titleFor` の連鎖を `customTitle → aiTitle → firstUserPrompt → nickname → auto-review ラベル → id 先頭 8 桁`
     に拡張。auto-review ラベルは `session.model === 'codex-auto-review'` のとき `auto-review·<id 末尾 4 桁>`
     （id 末尾は uuidv7 のランダム部で決定論的に一意）

UI 側（ui/office.js）:

3. **ストリームの連続同文畳み込み**: グローバル / セッション両ストリームで、表示リスト構築時に
   **隣接する同一行**（同一セッション + タイムスタンプ除去後の同一テキスト)を 1 行に畳み、
   `×N` バッジ（白 45%・小さめ）を付す。表示タイムスタンプは最新のもの。
   N の増加時は新着パルスを再発火するが、タイプインは初回出現時のみ。データ層（recentEvents）は変更しない
4. **密集耐性（分離の名札時代対応）**: 定数変更のみで挙動構造は変えない
   - `ORB_SEPARATION_X` 96 → **128** / `ORB_SEPARATION_Y` 54 → **72**（3 行ネームプレート + 吹き出しの実寸基準）
   - `ORB_CHILD_SEPARATION_X` 40 → **56** / `ORB_CHILD_SEPARATION_Y` 28 → **40**（衛星軌道 + 衛星名札ぶん）
   - pool の targetRadius 算出を **実効カウント**（通常 orb 1.0 + satellite 0.6）基準にし、
     係数を `90 + sqrt(effectiveCount) × 58` に引き上げ（上限クランプは従来どおり）
   - satellite は引き続き pairwise 分離の対象外（公転の決定論を守る。重なり軽減は上記の膨張と pool 拡大で行う）

制約: 実データ駆動・null 安全・決定論・既存レイヤ非破壊。ストリーム畳み込みは表示専用で
recentEvents の文字列契約・差分検知（newEvents）を壊さない。

### 軌道ベルトと群衆制御（v2.12 — 多衛星時代の観賞品質）

> v2.10 の軌道系は衛星 1〜2 体を想定していたが、実運用で「1 親に 7 衛星」が発生し、
> 2 半径の軌道で渋滞して光の団子になった。同心円リングの安易な増設は
> 「外側リング = 深い階層」という誤読（実在する孫表現との衝突）を招くため、
> **単一ベルトの拡張**を第一原理とする。

UI 側（ui/office.js / office.css）:

1. **軌道ベルト**: 親ごとの衛星軌道を単一ベルトに統一する
   - ベルト半径 `R = max(親 baseRadius × 2.35, 衛星数 × 56 / TAU)`（円周 ∝ 人数で確保。
     56px は衛星 orb + ミニネームプレートの実効間隔）。縦横比 0.58 は維持
   - ベルト内は等角配置（`idx / count × TAU + 公転時刻`）+ 小さな位相ジッタ（±0.12 rad・key シード）
   - **1 ベルト最大 8 体**。9 体以上で初めて 2 本目（半径 +20px の近接帯。階層シェルに見える
     大きな半径差は付けない）。各ベルトの R はそのベルトの人数で算出
   - 衛星ネームプレートは**ベルト内スロットの偶奇で上下交互**（偶数 = orb 下・奇数 = orb 上）に
     置き、ベルト上のテキスト衝突を半減させる
   - `entity.orbitRadius` は所属ベルトの R（軌道環描画は既存の半径 Set 重複排除で自然に 1〜2 本になる）
   - 子持ち分離膨張（v2.11 の固定 56/40）を実ベルト半径連動に変更:
     X 加算 = clamp(最大ベルト R × 0.9, 56, 96) / Y 加算 = clamp(最大ベルト R × 0.6, 40, 64)
2. **FOCUS モジュールの見切れ解消**: `.focus-module` の max-height を 44% → **56%** に引き上げ、
   全体ビューの全計器（TOTAL OUT / TOOL CALLS まで）が標準的なウィンドウ高で
   スクロールなしに視認できるようにする（module-scroll は小画面時の保険として維持)
3. **グローバルストリームの多様性**: 畳み込み（v2.11）適用後、**同一セッションの行は直近 3 行まで**に
   間引いてから表示上限（20 行）を適用する。多弁な一家が他セクターを押し流さないようにする。
   セッションビューのストリームは対象専用なので間引かない
4. **title 衝突の区別**: UI の正規化層で、同一プロジェクト内に表示 title が重複するセッションが
   複数あるときだけ、各表示 title に `·<id 末尾 4 桁>` を付す（fork 由来の同名や同 nickname の識別。
   一意なら何も付けない）。通常 orb のネームプレート・ツリー・ストリーム・FOCUS は同じ表示 title を使う。
   **衛星ミニネームプレートだけは v2.10 どおり nickname 優先**（短さと愛嬌を優先。厳密な識別は
   ツリー側のサフィックス付き title が担う。nickname が無い衛星はサフィックス込み表示 title）

制約: 決定論（key シード・等角配置）・lerp 遷移・reduced-motion / 30fps 構造の維持。
ベルトは階層を表現しない（階層は「軌道の中心が誰か + 関係線」のみが担う。v2.10 の原則を維持）。

### 引出線注記レイヤ（v2.13 — 星図アノテーションと発話の常時表示）

> 発話の吹き出し（不透明ボックス・6 秒で消滅）と hover ツールチップ（title / status を名札と重複表示）は
> 漫画と GUI の語彙であり、星図の語彙から浮いていた。両者を天体図鑑の**引出線注記
> （leader line callout）**に置き換えて統合し、あわせて「直近の発話がいつでも読める」観賞体験にする。

UI 側（ui/office.js のみ。サーバ変更なし — lastMessage / lastMessageAt / gitBranch / model /
startedAt は toPublicSession で公開済み）:

1. **引出線プリミティブ**: orb 縁（半径 + 4px）のアンカードット（半径 1.2px）から
   角度スロット方向へ斜線（伸長 28px）→ 水平シェルフ（ラベル幅 + 6px）→ シェルフ上にラベル
   - スロットは 4 方位（NE -36° / NW -144° / SE +36° / SW +144°、y 下向き座標）。
     親 orb は名札が下にあるため NE → NW → SE → SW の優先順。衛星はミニ名札（v2.12 の上下交互）の
     **逆側縦方向**を先に試す（名札が上なら SE → SW → NE → NW）
   - 同一フレームで確定済みの注記ラベル矩形と重なるスロットはスキップして次スロットへ
     （全スロット衝突時は優先スロットに強行）。配置順は展開注記 → スポットライト新しい順
   - 線: white alpha 0.10 × 注記 alpha・lineWidth 0.8。ラベル: 9px、本文 white 0.66 /
     補助行 white 0.45。メッセージ本文は wrapText で最大 2 行 × 150px・イタリック
   - ラベルの画面外は座標 clamp（既存吹き出しと同じ余白規則）。entity.opacity < 0.05 は描かない
   - 出現・消滅は alpha と伸長率（reach 0→1）の expLerp。アンカーは entity.x/y 直結
     （entity 位置自体が lerp 済みのため震えない）。reduced-motion はアニメなしで即時表示
2. **スポットライト注記（発話の常時表示）**: 既存 speechBubbles（不透明吹き出し）の置き換え
   - トリガは現行 emitSpeechBubble と同一（lastMessage の前進検知）。**保持 45 秒**（現行 6 秒から延長）
     + expLerp フェードアウト。**同時最大 2 件**（新しい発話が押し出した最古はその場からフェード）
   - 内容は最新メッセージ抜粋のみ（2 行 × 150px）。枠・背景ボックスは描かない（「覆わない」）
   - スポットライトまたは展開注記のメッセージ行を表示中（alpha > 0.05）の entity は
     名札 3 行目（現行の淡色 lastMessage 行）を出さない（同文の重複防止）。
     対象は親 orb + 衛星。spark は対象外
3. **展開注記（hover / FOCUS）**: 既存 drawTooltip の置き換え（title / status は名札と重複のため廃止）
   - hoveredKey / selectedKey の entity（重複は 1 回）に、データがある行だけ最大 3 本を展開:
     (a) 最新メッセージ 1 行（スポットライト表示中は省略）
     (b) `⎇ <gitBranch>`（canvas 初出の情報）
     (c) `<model 表示名> · <稼働時間>`（startedAt からの経過。canvas 初出の情報）
   - 各行は独立した引出線（1 惑星から複数本）。hover 開始で順に伸び、外れると溶けて消える
4. **旧表現の削除**: drawSpeechBubbles / drawTooltip とその呼び出しを削除する
   （wrapText / roundedRect 等の汎用ヘルパは他所で使っていれば残す）

制約: 描画順は nameplates の後の最上層に callouts を追加（drawOrbs → nameplates → callouts）。
名札にある情報を注記に再掲しない。canvas fillText のみ（XSS 制約）・30fps・reduced-motion・
決定論（スロット選好は状態から一意）の維持。

### モーション品質

- requestAnimationFrame ループ（**30fps にフレームスキップでキャップ**）。位置・輝度・スケールは全て lerp/減衰の連続変化。CSS keyframes の繰り返しに頼らない
- `document.hidden` で rAF 完全停止・復帰で再開（最小化時に CPU を使わない）
- `prefers-reduced-motion: reduce`: 徘徊・波紋・呼吸を停止し、静的配置と輝度差のみで表現
- devicePixelRatio 対応。リサイズで pool レイアウト再計算（lerp 遷移）

### インタラクション

- hover: orb がわずかに増光 + 展開注記（v2.13 の引出線。canvas 描画）
- click: 詳細パネル開閉（ヒットテスト = orb 半径 + 8px）。Esc / スクリム / × で閉じる。パネル表示中も背景は動き続ける

### タイポグラフィ / 色

- system-ui スタック。英字ラベルは letter-spacing 0.08em の小さめキャップス
- パレット: 背景 #070b14→#0d1322 / claude コア #ffc9a3・グロー #ff8a5c / codex コア #a7e3ff・グロー #4fa3e3 / テキストは白の 40〜85% 不透明度のみ。彩度の高い UI 色は使わない

### 実装構成（ui/office.js 内のモジュール分割）

- `WSClient`: 再接続付き WebSocket（v1 ロジック踏襲）
- `Store`: snapshot を `key` ベースで diff し、エンティティ生成/更新/退場を発行
- `Sim`: pool レイアウト（phyllotaxis + lerp）、orb 操舵（seeded noise）、satellite/spark 軌道、波紋・粒子の寿命管理
- `Renderer`: 背景 → pool → trail → orb（ハロー→コア→顔→ラベル）→ 波紋 の順に描画
- `Interaction`: pointermove / click ヒットテストとツールチップ状態
- `A11y`: visually-hidden リストの同期

## Electron（electron/main.js）

- `src/server.js` の起動関数を import → listen 完了後に `BrowserWindow`（1280x800, 背景ダーク）で token 付き loopback URL をロード
- `webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }`。preload なし（データは WS 経由のみ）
- Renderer の通信は `defaultSession.webRequest` で、起動した Agentarium server と同じ
  `127.0.0.1:<port>` の HTTP / WebSocket だけを許可する。macOS の `Info.plist` も
  `NSAllowsArbitraryLoads=false` とし、カメラ・マイク・音声・Bluetooth の usage description を含めない
- 全ウィンドウクローズで app.quit()（mac の再活性化定型は入れてよい）
- 初期画面の load 完了後に、URL やセッション内容を含まない readiness 行を stdout へ出す。packaged smoke は
  空の一時 HOME で通常起動し、この行とプロセス継続を確認する

## 検証手段

- `pnpm run scan` → 現在の実ログから組んだ状態 JSON を stdout に出す
- `pnpm run web` → stdout に表示された token 付き URL をブラウザで開いて UI 確認
- `pnpm start` → Electron 起動確認
- `pnpm run package:mac --arm64` → Developer ID 未署名・ad-hoc 署名のローカル検証用 app を生成
- `pnpm run dist:mac --arm64` → Homebrew Cask で配布可能な Developer ID 未署名・ad-hoc 署名 zip を生成
- `pnpm run dist:mac:signed --arm64` → 資格情報がある場合だけ署名・notarization 済み zip を生成
- `pnpm run smoke:package "dist/mac-arm64/Agentarium Space.app" arm64` → ASAR 内の server / UI / 依存解決と
  bundle identifier・最低 OS・実行 architecture を確認
- `pnpm run package:win` → Windows x64 の unpacked app を生成
- `pnpm run dist:win` → Windows x64 の portable EXE を生成
- `pnpm run smoke:package:win "dist/win-unpacked/Agentarium Space.exe" x64` → Windows 上で ASAR・実行
  architecture・ローカル HTTP 配信・Electron ウィンドウの readiness・継続実行を確認
- `pnpm run smoke:portable:win "dist/agentarium-space-<version>-windows-x64.exe"` → Windows 上で最終
  portable EXE の展開・起動後に loopback server が継続して待ち受けることを確認

## v1 スコープ外（実装しない）

- 通知 / 許可待ち（permission prompt）検知 / トークン・コスト集計 / 履歴タイムライン / 設定画面
