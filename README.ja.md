# ArkWork

[English](./README.md) | [简体中文](./README.zh-CN.md) | **日本語** | [한국어](./README.ko.md)

> ローカルファーストの AI Agent ワークベンチ — ReAct 推論ループを**可視化・制御可能・再利用可能**に。

![License](https://img.shields.io/badge/license-Apache%202.0-blue) ![Electron](https://img.shields.io/badge/Electron-33-47848F) ![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

![ArkWork ワークベンチ — リアルタイム ReAct ステップストリーム、ask_user ステージゲート、プランリスト](docs/screenshots/workbench-react-task.png)

多くの AI 製品では Agent の推論はブラックボックスです。デバッグもできない、途中で介入もできない、コンテキストも制御できない。ArkWork は ReAct ループをファーストクラスのオブジェクトに変え、観察・誘導・再利用を可能にします — すべてのデータはお手元のマシンにだけ残ります。クラウドも、テレメトリもなし。会話・記憶・インデックスはワークスペース内のプレーンなファイルに保存され、モデル呼び出しはあなたが設定した API キーで直接行われます。

**[ダウンロード](https://github.com/q648253885/ArkWork/releases)** からビルド済みインストーラ（macOS Apple Silicon / Intel、Windows、Linux）を入手、または下記の手順でソースからビルドしてください。

> **公式ウェブサイト**：[www.hellowl.com](https://www.hellowl.com/) — 製品ホームページ、機能紹介、スクリーンショット、ダウンロード。

## 主な機能

### 1. 可視化された ReAct エンジン

各タスクは Reason → Act → Observation ループを完全にストリーミング＆永続化しながら実行します。

- **リアルタイムステップタイムライン** — Reason / Act / Observation を色分けし、繰り返し番号・所要時間・トークン消費量を表示。同一ターン内の複数ツール呼び出しは並列実行され、各々が独立したステップとして記録されます。
- **いつでも介入可能** — 任意の瞬間に Pause / Resume / Cancel（`Esc`）。確認が必要な場面ではエンジンが `ask_user` ゲートで停止し、クリック可能な選択肢を提示します。確定した時点で中断地点から継続します。
- **コンテキストはあなたのもの** — L1 作業記憶の各アイテムをチェックして、次のターンのコンテキストに含めるかどうかを制御。Context パネルがソース別の注入比率を可視化します。
- **安全機能を内蔵** — doom-loop 検出、ツール呼び出しの署名/カテゴリ別予算、繰り返し上限到達時はハード失敗ではなく優雅な一時停止、トークン閾値超過時の自動圧縮。
- **Checkpoint** — 各ターンを自動保存し、任意のターンに巻き戻し＆再実行可能。

### 2. 4 層メモリシステム

メモリは `<workspace>/.arkwork/` 配下にプレーンファイルで永続化されます — **データベースも embedding サービスも不要**。検索はローカル全文検索（MiniSearch）なので、システム全体はオフラインで動作します。

| レイヤー | 保管内容 | 振る舞い |
|---------|----------|----------|
| **L1 作業記憶** | 単一タスクの会話・推論・ツール observation | チェック / 編集 / アーカイブ可能。トークン閾値で自動圧縮 |
| **L2 ファイル記憶** | タスク成果物と大型ツール結果 | タスクディレクトリに書き込まれ、ステップから参照 |
| **L3 キュレーション** | `memory.md` + `user.md` ノート | 「覚えておいて…」は一旦 pending 領域に入り、次回実行でマージ。超過時は LLM がロッシーマージ |
| **L3 アーカイブ** | 完了済みタスクの完全 L1 | 不変、クロスセッションで全文検索可能 |
| **L4 ユーザープロファイル** | 好み・訂正・スタイル観察 | LLM が ≤500 tokens のプロファイルを合成。バージョン 10 個を保持しロールバック可能 |

蒸留パイプラインが L1 項目を再利用可能な事実・スキル・知識庫アイテムに変換します — 経験は消えるのではなく蓄積されます。

### 3. Coding エージェント（`@coder`）

実用的なソフトウェア開発のために調整された内蔵エージェント。ツールベルトは他エージェントと共通です：

- **ドキュメント駆動開発** — always-on のコアスキルが PRD → spec → plan → 段階的実装を推進し、**ステージゲート**で各段階の開始前に `ask_user` による確認を必須化。
- **エンジニアリングスキルを同梱** — `spec`、`plan`、`bugfix`（bugfix は専用の loop runner を搭載）。
- **フルツールベルト** — ファイルの読み書き / 編集、glob & grep 検索、shell（4 段階のリスク評価 + 監査ログ）、web 検索、URL 取得、ブラウザ自動化、サブエージェント委譲。
- **5 段階の権限モード**（`Shift+Tab`） — default / auto-approve / accept-edits / plan / bypass。危険なツールは洗練されたアプリ内レイヤーで確認を要求し、承認はセッション単位で記憶されます。

![設定-詳細：権限モード、allow ルール、メモリ圧縮チューニング](docs/screenshots/settings-advanced-permissions.png)

### 4. ナレッジベース

- **PDF / DOCX / TXT / Markdown** をインポート可能。文書は段落境界でチャンク化（約 500 tokens + オーバーラップ）され、ローカルにインデックス化されます。
- ナレッジベースは**タスク単位で有効化**。実行開始時にも自動想起注入を行います。
- Agent は `kb-search` スキルで能動的に検索可能。**ベクター DB は不要**。

### 5. スキルとマーケットプレース

- 内蔵ツール・MCP ツール・命令型スキル（`skill.json` + `SKILL.md`）を統一した抽象で扱うことができます。
- 命令モード：**always-on**（システムプロンプト注入）、**on-demand**（呼び出し時にロード、持続的に有効）、**hint-only**。スキルはゲートを宣言可能。
- レイヤー付き探索 — project > user > bundled > runtime — 直近のレイヤーが下層をシャドウ。`SKILL.md` は呼び出し時にのみオンデマンドでロード（プログレッシブ・ディスクロージャー）。
- **マーケットプレース**：コミュニティスキルの検索とワンクリックインストール、お気に入り・検索履歴を完備。

### 6. MCP サポート

依存ゼロの自前実装 JSON-RPC 2.0 クライアント、**stdio トランスポート**：複数サーバーを並行管理、`tools/list` でツールを発見してランタイムスキルとして注入（切断時に自動削除）、ハートビートと自動再接続を実装。

### 7. 内蔵ブラウザ

複数タブ対応のブラウザが Inspector ドックに常駐し、Agent から操作可能：

- `snapshot` で安定した `ref=e<N>` 番号付きインタラクティブ要素ツリーを出力。click / type / select / press / scroll は ref 優先で位置特定。
- console ログをキャプチャ。スクリーンショットを保存しマルチモーダルモデルに送信。
- **人間とエージェントのコ・パイロット**：ユーザーがページ内をクリックすると人間が主導権を握り、Agent はマウスを奪い返そうとせず明示的なエラーを受け取ります。

### 8. 任意の LLM プロバイダ

- プロバイダ種別：`openai` / `anthropic` / `ollama` / `vllm` — OpenAI アダプタは互換エンドポイント（DeepSeek、Moonshot、Qwen、ローカルサーバー…）もすべてカバー。
- Anthropic アダプタは Claude Code 風の prompt caching（≤4 ブレークポイント）と extended thinking ストリーミングを実装。reasoning content とキャッシュヒット統計を可視化。
- モデルごとに能力フラグを宣言し、接続テストを内蔵。Composer 底部のチップから即座に切り替え可能。

### 9. オートメーション

cron でスケジュールされたタスクは定時になると完全な Agent フローを起動。同分内重複排除、起動時のキャッチアップ tick を備え、すべてローカルに永続化されます。

### 10. チャットボックスではなく、ワークベンチ

- 3 ペインレイアウト + IntelliJ 風 Inspector ドック：Todos / Context / Files / Terminal / Logs / Browser（`⌥1~6` で切替）。
- タスクリストとステップタイムラインは**双方向にスクロール同期** — リストの項目をクリックすると、それを生み出したツールステップへジャンプ。
- Quick Action `⌘K`（タスク / ファイル / エージェント / コマンド検索）、QuickOpen `⌘P`、フローティング Preview `⌘E`（Markdown、コード、画像、SVG、表、ブラウザ）。
- ダーク / ライトテーマ、UI は **简体中文 · English · 日本語 · 한국어** をサポート。ワークスペース切替、実行タスク数 / メモリ使用量 / アクティブモデルを表示するステータスバー。

![設定-外観：ダーク / ライトテーマと 4 言語 UI](docs/screenshots/settings-appearance-i18n.png)

![ヘルプセンター：完全キーボードショートカット一覧](docs/screenshots/help-center-shortcuts.png)

## 技術スタック

| レイヤー | 採用技術 |
|---------|----------|
| ランタイム | Electron 33 + Node.js（ESM） |
| ビルド | electron-vite 2.3 + Vite 5 + electron-builder 26 |
| フロントエンド | React 18.3 + TypeScript 5.6 + Tailwind CSS 3.4 + Zustand 5 |
| LLM SDK | `@anthropic-ai/sdk` + `openai` |
| 検索 | MiniSearch（ローカル全文、ベクター DB 不要） |
| 永続化 | ファイルシステム（JSON / JSONL）— データベースなし |

## クイックスタート

要件：Node.js ≥ 18、npm。

```bash
git clone https://github.com/q648253885/ArkWork.git
cd ArkWork/app
npm install
npm run dev
```

開発モードでは、メインプロセスは `.dev-data/` を userData として使用し、Vite dev server は `http://localhost:5174/` をリッスンして Electron ウィンドウが自動で開きます。

インストーラのビルド：

```bash
npm run build:mac    # macOS dmg + zip（Apple Silicon arm64 + Intel x64）→ app/release/
npm run build:win    # Windows NSIS インストーラ (x64)
```

### モデルの設定

初回起動時に **設定 → モデル**（`⌘,`）を開きます：

1. 「モデルを追加」をクリック
2. id / name / kind（`openai` / `anthropic` / `ollama` / `vllm`）/ baseURL / apiKey を入力
3. 「テスト」をクリックして接続を確認
4. 保存後、Composer 底部のモデルチップからいつでも切替可能

## ドキュメント

| 言語 | ユーザーガイド |
|------|----------|
| 简体中文 | [docs/user-guide.zh-CN.md](./docs/user-guide.zh-CN.md) |
| English | [docs/user-guide.en.md](./docs/user-guide.en.md) |
| 日本語 | [docs/user-guide.ja.md](./docs/user-guide.ja.md) |
| 한국어 | [docs/user-guide.ko.md](./docs/user-guide.ko.md) |

インストール、モデル設定、コアコンセプト（ワークスペース / タスク / エージェント / スキル / メモリ / ナレッジベース）、日常のワークフロー、キーボードショートカット、FAQ、トラブルシューティングを網羅。

## ディレクトリ構成

```
ArkWork/
├── app/                        # Electron アプリケーション
│   ├── src/
│   │   ├── main/               # メインプロセス（agent engine / memory / kb / automation /
│   │   │                       #   mcp / checkpoint / ipc / llm / store /
│   │   │                       #   fs / browser …）
│   │   ├── preload/            # Preload ブリッジ（contextBridge）
│   │   ├── renderer/           # レンダラプロセス（React UI、i18n 4 ロケール）
│   │   ├── shared/             # 共有型とユーティリティ
│   │   └── test/               # テスト基盤（electron スタブ loader）
│   ├── scripts/                # 統合テストランナ + i18n ツール
│   └── build-resources/        # アイコンとパッケージングリソース
├── docs/                       # ユーザー向けドキュメント + スクリーンショット
└── README.md
```

## キーボードショートカット

| キー | アクション |
|------|--------|
| `⌘K` | Quick Action（検索 / コマンド / `>` `@` `#`） |
| `⌘P` | Quick file open |
| `⌘B` | サイドバー切替 |
| `⌘,` | 設定 |
| `⌘1~6` | エージェント / スキル / ナレッジ / メモリ / オートメーション / 設定 |
| `⌥1~6` | Inspector：Todos / Context / Files / Terminal / Logs / Browser |
| `⌘E` | Preview ウィンドウ |
| `Shift+Tab` | 権限モードの切替 |
| `Esc` | オーバーレイを閉じる / 実行中タスクを一時停止または停止

完全な一覧はアプリ内ヘルプセンター（`⌘/`）にあります。

## テスト

```bash
cd app
npm test            # 統合ランナ：src/**/__tests__/*.test.ts(x) を自動検出
npm run typecheck   # node と web の 2 つの tsconfig で tsc 検証
```

## ライセンス

[Apache License 2.0](./LICENSE)