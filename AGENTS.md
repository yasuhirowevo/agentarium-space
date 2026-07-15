# AGENTS.md

Agentarium Space の開発を引き継ぐ AI エージェントへ。コードや見た目に手を入れる前に、必ず次の 2 つを読むこと。

1. [PHILOSOPHY.md](./PHILOSOPHY.md) — デザイン思想と判断基準。何を良しとし、何を捨てたか
2. [DESIGN.md](./DESIGN.md) — 仕様の正典。データソース形式・状態モデル・UI 各レイヤ（v2.x）

最低限の掟（詳細は PHILOSOPHY.md §4–5）:

- ログは読み取り専用。ネットワークは 127.0.0.1 のみで外部送信ゼロ
- Anthropic / OpenAI の商標・ロゴ・アセットを使わない
- レイアウトの再配置・振動アニメ・ダミー計器・オーバーレイ UI を再導入しない
- 変更は DESIGN.md への仕様追記が先、実装が後
- 検証: `pnpm run scan` / `pnpm run web`（stdout に表示された起動ごとの URL を開く）
