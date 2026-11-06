# Agent Workbench 詳細設計書
## Codex + Herdr 上で動く、証拠と承認を管理するローカル・エージェント実行基盤

**設計版:** 1.0 / **基準日:** 2026-11-05 / **仮のコマンド名:** `aw`

**実装対象:** 新規リポジトリ `agent-workbench`。既存の業務リポジトリとは分離する。

**成果物の位置付け:** 実装仕様・機械可読契約・検証用参照モデル。完成済みのアプリケーションではない。

---

## 0. 読み方と設計上の決定

この設計書は「いくつかの実現方法を比較する資料」ではなく、実装者がゼロから組み立てるための決定済みの仕様である。`MUST` は必須、`SHOULD` は例外理由を記録した場合だけ変更可能、`MAY` は任意とする。既存サービスの仕様を説明する箇所は `[S番号]`、このツールの独自仕様は「設計決定」として区別する。

ユーザーが明示した前提は、普段の実行環境が **Codex + Herdr** であり、Claude CodeやPiへの乗り換えを目的にしていないことである。MacBook利用に合わせてmacOSを第一対象、Linuxを第二対象とする。Herdrの導入版、Codexの導入版、SSH運用の有無は確認できていないため、設定から明示的に選択し、実機の仕様を取り込む `aw doctor` を必須にする。業務リポジトリのコマンドはこの作業では調査していない。`ugo_hub` 向けの名前を付けた例があっても、ビルドコマンドやディレクトリ構成を検証済みだとは扱わない。

### 0.1 一文で表す目的

**「LLMが完了と言った」ではなく、「特定の変更に対して、必要な検証・独立レビュー・人間の承認が揃った」を管理する。**

実装対象は次の五つに限定する。

| 機能 | 実現する保証 | 実現しない保証 |
|---|---|---|
| 独立した作業環境 | タスクごとのcheckoutと書き込み担当を分ける | worktreeだけによる悪意あるプロセスの隔離 |
| 検証とレビューのゲート | 判定を不変の候補コミットへ結び付ける | すべての欠陥を発見すること |
| 反証型Board | 初期回答と各ラウンドの公開順序を制御する | モデル同士の誤りが統計的に独立であること |
| 目的指向Handoff | 次の目的に必要な文脈と原本参照を残す | 元の会話の完全な無損失要約 |
| 中断・復旧 | 不明な実行を成功扱いせず、安全な再開点を示す | 外部副作用の無条件のexactly-once実行 |

### 0.2 前回答から具体化・修正した点

1. **Herdrにはworktree操作が存在する。** したがって「Herdrにないから全部自作する」という前提は採らない。[S2] ただし本設計では、候補コミット・検証・承認とGit操作を一元管理するため、Git lifecycleの所有者を `aw` に固定する。Herdrは既に作成済みのcheckoutを表示する。両方から作成・削除しない。
2. **通常のCodex TUIとApp Serverは別経路である。** 同じ会話を両方で同時に動かすことを前提にしない。ネイティブTUIは対話用、App Serverは管理実行用とする。[S1]
3. **「別セッション」と「別モデル提供元」は違う。** Codexだけでも文脈を分離したレビューはできるが、クロスベンダー検証とは表示しない。
4. **単なる承認ボタンでは足りない。** 承認はコミット、対象ブランチの基点、ポリシー、仕様、検証計画、証拠集合のハッシュに拘束する。
5. **ユーザーの作業中の `develop` を自動で書き換えない。** タスク用のmanaged bare repositoryを別途作り、そこでの統合を標準にする。業務リポジトリへの反映とGitHubへの公開は別の操作である。
6. **同一OSユーザーの権限を共有する限界を隠さない。** ローカルな承認ゲートは運用上の統制であり、ホストそのものを乗っ取った攻撃者への防御にはならない。

### 0.3 採用・非採用

| 採用 | 理由 |
|---|---|
| TypeScript、Node.js 24以上、pnpm | ユーザーの既存技術領域に近く、Codexの型を利用しやすい |
| JSON Schema + Ajv | 入出力・保存物・LLM出力を同じ契約で検証する |
| SQLite、単一daemon書き込み | 外部DBを必要とせず、状態遷移とイベントを原子的に保存できる |
| Codex App Server | thread/turn・構造化イベント・中断・承認要求を明示的に扱う |
| Herdr TUI Adapter | 現在の操作環境を維持し、画面を作り直さない |
| Gemini REST Adapter | Claude Codeなしで別提供元のレビューを実現する、任意の追加経路 |
| Git CLI | Gitのオブジェクトと参照更新を独自実装しない |
| 一意な作業ディレクトリ | 初版でworktree再利用の複雑さを持ち込まない |

非採用は、独自LLMループ、独自ターミナル、独自Web UI、分散スケジューラ、Redis、常設クラウド、人格ごとのエージェント、無制限の再帰委任、READMEからそのまま取り込むYOLO設定である。Skillの自動インストールも初版には不要で、通常のCLIから全機能を使えることを優先する。

### 0.4 リリースの境界

- **R0 — オフライン基盤:** fake providerでタスク作成からローカル統合まで動く。
- **R1 — 日常利用:** Herdr TUI + Codex App Serverで実装、検証、別セッションレビュー、人間承認、復旧が動く。
- **R2 — 抽出した革新の完成:** 別提供元レビュー、Board、Handoff、ネイティブCodex対話経路、Git bundle出力が動く。本設計の完成判定はR2。
- **拡張:** GitHub draft PR発行、Herdr Core `hc`、複数ホスト集約。R2の必須条件にしない。契約と制約は定義するが、動作確認なしで対応済み表示をしない。

---

## 1. 利用者から見た完成形

### 1.1 初回設定

```bash
# 以下のawコマンドは本設計で作るCLI。既存製品のコマンドではない。
aw init
aw doctor --capture-protocols
aw setup profiles
aw repo add ~/src/ugo_hub --name ugo-hub --base refs/heads/develop
aw policy import --repo ugo-hub --file ./project-policy.json
aw policy trust --repo ugo-hub
aw daemon start
```

`repo add` は元のrepositoryを読み取り、別のmanaged Git repositoryを作る。元のworktree、`.git/config`、グローバルGit設定、GitHubのIssue/PRは変更しない。`policy trust` は利用者自身のターミナルから実行し、実行予定のbootstrap・検証コマンドと外部提供元への送信範囲を表示する。

### 1.2 仕事を開始する

```bash
aw task create --repo ugo-hub --spec ./task.json
# => {"taskId":"tsk_...", "state":"ready"}

aw task start tsk_... --interaction managed --presentation herdr-tui
aw task status tsk_...
aw task logs tsk_... --follow
```

Herdrにはタスク用workspaceと出力ペインが現れる。管理実行ペインに表示するのは `aw` のセッション表示であり、ネイティブCodex TUIの複製ではない。Codexの推論とコード編集はApp Serverが担当する。利用者はHerdrのペインから `aw task send` で追加指示し、必要な操作だけ承認する。

### 1.3 完了前の流れ

```text
仕様確定
  → 独立checkout
  → Codexによる実装
  → writer停止確認
  → 候補コミットCを固定
  → 別checkoutで検証
  → 新規セッションで独立レビュー
  → 指摘の処置
  → Cに対する承認
  → managed integration refをBからCへCAS更新
  → 必要ならbundleを出力
```

`aw task status` は「処理中」「人間待ち」「検証不足」「承認待ち」「管理領域へ統合済み」を区別する。「管理領域へ統合済み」を「GitHubへマージ済み」と表示してはいけない。

### 1.4 ネイティブCodexを維持したい作業

```bash
aw task start tsk_... --interaction native --presentation herdr-tui
# Herdrの専用ペインで通常のCodex CLIに直接指示する。
# 編集を終えたらCodexを終了させてから実行する。
aw task finish tsk_...
```

この経路でも後段の候補固定、テスト、レビュー、承認は共通である。ただしTUIの「idle」は完了ではない。プロセス終了が確認できないまま `finish` された場合は拒否する。既に動いている任意のペインへ勝手に接続・指示・終了する機能は初版に設けない。

### 1.5 最後の承認

```bash
aw approval inspect apr_...
aw approval grant apr_... --expect-digest sha256:...
aw task integrate tsk_... --approval apr_...
aw task export tsk_... --format git-bundle --out ./change.bundle
```

作業途中の「LGTM」を拾って自動マージしない。モデルのツールにも `grant` を公開しない。承認後に基点や証拠が変わると、上記の統合は `APPROVAL_STALE` で失敗する。

---

## 2. 全体構造と責務

```text
Human terminal / Herdr
      │ command, query, approval
      ▼
aw CLI ────────── Unix socket ─────── aw daemon
                                       ├─ command handler / state reducer
                                       ├─ SQLite / transactional outbox
                                       ├─ scheduler / operation journal
                                       ├─ Git workspace + integration service
                                       ├─ check / review / Board / handoff service
                                       └─ artifact store
                                                 │ attempt ticket
                              ┌──────────────────┴──────────────────┐
                              ▼                                     ▼
                     aw worker                              native Codex TUI
                     ├─ own Unix socket                     └─ Herdr-owned PTY
                     ├─ durable event spool
                     └─ Codex App Server / Gemini API
                              │
                              ▼
                     sandboxed tools / immutable input
```

### 2.1 制御面・実行面・表示面

**制御面:** daemonがタスク状態、証拠、承認、Git参照更新を所有する。ここにLLMの判断は直接入り込まない。LLM出力は検証された入力として扱う。

**実行面:** workerが一つのattemptを所有する。Codexのthreadやturn、HTTPリクエスト、プロセス終了、中断を管理する。daemonが短時間落ちてもworkerがjournalへ追記し続けられる。workerはSQLiteに接続しない。

**表示面:** Herdrはペイン、タブ、workspace、フォーカス、端末状態を所有する。Herdrの状態を業務上の成功判定に変換しない。daemonが止まっても既存Herdrセッションを止めない。

### 2.2 一つの対象には一つの所有者

| 対象 | 所有者 |
|---|---|
| managed repository内のref、worktree lifecycle | Git service |
| ユーザーの元repository | ユーザー。awは読み取りだけ |
| task状態とapproval | daemon |
| 一つのworktreeへの書き込み権 | 一つのactive attempt |
| Codexのthreadへの入力送信 | そのattemptのworkerだけ |
| Herdrのペイン入力（managed） | worker launcher。以後モデル出力をキー入力で再注入しない |
| Herdrのペイン入力（native） | ユーザー。awの自動送信は開始時だけ |
| Boardのラウンド公開 | Board coordinator |
| 実行結果の真偽 | 観測事実とポリシー。LLMの自己申告では決めない |

### 2.3 依存方向

```text
cli → application → domain
             ↓
         ports/interfaces
             ↑
adapters/{codex,herdr,gemini,git,sqlite,filesystem}
```

`domain/` は `node:child_process`、SQLite、HTTP、Herdr、Codexのgenerated型をimportしない。純粋なstate reducer、gate判定、digestの入力型だけを置く。外部プロトコルの変更はadapter内で吸収する。

### 2.4 リポジトリ構成

```text
agent-workbench/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  src/
    cli/main.ts
    cli/commands/{init,doctor,repo,task,approval,board,history}.ts
    daemon/{main,server,auth,command-handler,reconciler,scheduler}.ts
    domain/{task,candidate,gate,approval,board,events,errors}.ts
    application/{task-service,git-service,review-service,board-service,
                 handoff-service,artifact-service,verification-service}.ts
    ports/{agent-driver,presentation-driver,command-runner,store,clock}.ts
    adapters/
      codex/{client,framing,generated-bridge,driver,normalizer}.ts
      herdr-tui/{client,launcher,normalizer,reconciler}.ts
      gemini/{client,driver,context-builder}.ts
      fake/{driver,clock,fixtures}.ts
      git/{runner,repository,worktree,snapshot,integration}.ts
      sqlite/{db,migrations,repositories}.ts
      os/{process,paths,sandbox,atomic-file}.ts
    worker/{main,ticket,journal,server,supervisor}.ts
    contracts/                         # この配布物のcontractsをコピー
    prompts/{implement,review,board,handoff}.ts
    generated/{codex,herdr}/            # 利用バイナリから生成し固定
  test/{unit,contract,integration,chaos,e2e}/
  fixtures/{repos,protocols,outputs}/
  scripts/{capture-protocols,verify-generated,package-smoke}.mjs
  docs/
```

初版ではmonorepoにせず、一つのpackage内の境界で管理する。npm公開は不要で、`pnpm build` 後のローカルCLIで動く。配布時にcontracts、migrations、generated schema、バージョン情報を必ず同梱する。

---

## 3. 絶対に破ってはいけない不変条件

以下を要求IDとして全テスト・実装タスクへ付与する。

| ID | 不変条件 |
|---|---|
| I01 | 同じworktreeに同時にactive writerは一つだけ |
| I02 | taskの成功はproviderの終了コードやHerdrのidleだけで確定しない |
| I03 | 必須check/review/approvalは同一のcandidate identityへ紐づく |
| I04 | 仕様・ポリシー・検証計画・証拠・基点の変更で古いapprovalを失効させる |
| I05 | ユーザーの元checkoutとchecked-out branchを自動更新しない |
| I06 | integration ref更新はexpected-old-SHAを伴うCASだけ |
| I07 | プロセスが生きている可能性が残る間はwriterを再割当しない |
| I08 | eventの再配送・順序逆転が二重実行や状態巻き戻しを起こさない |
| I09 | Boardのblind段階と未sealラウンドの他席の回答を席に渡さない |
| I10 | LLMにapprove、publish、integrateの権限を与えない |
| I11 | 復旧不能・不明・証拠欠落を成功とみなさない |
| I12 | 外部サービスへの送信はrepo単位の明示的な許可に従う |
| I13 | source configuration、user prompt、LLM outputをshell commandとして展開しない |
| I14 | validation outputとruntime状態はモデルの編集対象から分離する |
| I15 | 別セッションを別ベンダーとして数えない。実際のprovider/familyを記録する |
| I16 | 未コミット変更・未マージcommit・不明な作業ディレクトリを自動削除しない |
| I17 | 依存タスクの成果物もSHAで固定する。移動するブランチ名を証拠にしない |
| I18 | 同一タスクの修正は新generation/candidateを作り、過去の証拠を上書きしない |
| I19 | 未知の必須外部APIや未知の承認要求はfail-closedにする |
| I20 | ログ欠落、budget不明、sandbox不成立を黙って正常表示しない |

`I01`、`I06`、`I08`、`I09` はコードとテストで機械的に検証する。`I10`の悪意ある同一UIDからの防御、`I14`のホスト管理者からの防御まで証明したと主張してはいけない。信頼境界はセキュリティ章で限定する。

---

## 4. 名前、ID、ハッシュ、時刻

- IDは `prefix_` + UUID v4の小文字・ハイフンなし32桁。例: `tsk_<32hex>`、`run_<32hex>`、`cand_<32hex>`、`apr_<32hex>`、`brd_<32hex>`。
- 表示用slugは任意であり、identityには使わない。タスク名やLLM生成タイトルをパス・refに直結させない。
- Git OIDはrepositoryのobject formatに応じ40桁または64桁。40桁固定の実装は禁止する。
- artifact/digestは `sha256:<64hex>`。Git OIDと区別する。
- authoritative timestampsはUTC epoch millisecondsの整数。UIだけJSTなどに変換する。
- duration/timeoutはプロセス内のmonotonic clockで測る。leaseのwall-clock期限は観測用途であり、期限切れだけではwriterを回収しない。
- canonical JSONは後述の `canonical-json-v1` を使う。文字列を勝手にUnicode正規化しない。整数はsafe integer、floatはdigest対象で禁止、重複object keyを受け入れない。
- candidate identityの項目順はserializerへ委ね、手作業の文字列連結でhashを作らない。


---

# 5. ドメインモデル・状態遷移・永続化

## 5.1 正式な契約ファイル

`contracts/` のJSON SchemaとSQLを実装へコピーし、変更する場合は設計書とテストを同じ変更で更新する。外部Codex/Herdrの型はこの契約に混ぜない。

| ファイル | 用途 |
|---|---|
| `task-spec.schema.json` | ユーザーから受け取る仕事の目的・範囲・要求・予算 |
| `project-policy.schema.json` | 人間が信頼した検証コマンド、レビュー強度、送信先 |
| `model-profile.schema.json` | driver・実際のprovider・training family・model |
| `candidate-identity.schema.json` | 承認対象の不変なidentity |
| `implementation-output.schema.json` | 実装者の自己申告。成功の証拠ではない |
| `review-output.schema.json` | 独立レビューの機械可読出力 |
| `approval-binding.schema.json` | 何を何の条件で許可したか |
| `board-charter.schema.json` / `board-post.schema.json` | Boardの目的と各席の提出物 |
| `handoff.schema.json` | 目的指向の引き継ぎ |
| `worker-event.schema.json` | workerからdaemonへの外側のevent envelope |
| `state-machine.json` | 許されるtask遷移の一覧 |
| `001_initial.sql` | 初回migration。実行できるDDL |

JSON Schemaが保証するのは形である。存在する要求ID、重複ID、パスの許可範囲、SHAの整合、予算の合計、Boardの席数などの意味的な制約はapplication validatorで追加する。`worker-event.data` は外部互換性のためobjectだが、正規化後は各event type専用validatorを通す。未知のtypeをstate reducerへ流さない。

## 5.2 主要オブジェクト

**Task:** 利用者の目的と受け入れ条件。仕様本文は各generationで固定する。仕様変更は `revise` 操作とし、履歴をartifactに保存する。`tasks.spec_json` は現在版で、過去版はeventとartifactで復元可能にする。

**Attempt:** 一回の実行。成功・失敗・中断後に同じattemptを再利用しない。再開には新しいattemptを作り、必要なら既存のnative sessionを排他的にresumeする。

**Workspace:** 一つのcheckout。writer/check/review/experimentで分離する。writerの `generation` が変わっても過去のcheckoutを消さず、新しいものを割り当てる。

**Candidate:** base Bに対する完成候補C。tree、仕様、policy、instructions、context、検証計画、環境identityを固定する。コードが1行変わっただけでも新しいcandidateになる。

**Evidence:** runnerが観測したcheck結果、validatorが受理したreview、指摘の処置。モデルの自然言語をcheck成功へ変換しない。

**Approval:** candidate identityとevidence集合と統合先を拘束した一回限りの操作許可。人間に表示したdigestと同じ値に対してのみ記録する。

**Integration:** Git参照更新という外部副作用のjournal。DBのtransactionとGitを一つのtransactionにできないため、prepared/applied/uncertainを区別する。

## 5.3 Task状態と必須ガード

実装では `reduceTask(state, event, facts) -> TransitionResult` を純粋関数にする。`state-machine.json` にない組み合わせは `INVALID_TRANSITION`。

| 現在→次 | イベント | 必須ガード |
|---|---|---|
| draft→ready | TASK_SUBMITTED | spec/意味検証合格、trusted policy存在、profile解決済み |
| ready→allocating | START_REQUESTED | 依存完了・依存SHA固定、同一taskのactive runなし、予算残あり |
| allocating→running | WORKER_READY | checkout・lease・worker identity・sandbox検査が一致 |
| running→waiting_human | INPUT_REQUIRED | 現active attemptの要求。provider承認要求と業務質問を区別 |
| waiting_human→running | HUMAN_REPLY | requestId/turnIdが現在も有効。期限切れ要求への返信は禁止 |
| running→freezing | IMPLEMENTATION_RETURNED | 成功終了を観測、必要出力あり、実装完了宣言。まだtask成功ではない |
| running→freezing | NATIVE_FINISH_REQUESTED | 人間要求。native writer終了と残存子プロセスの確認済み |
| freezing→verifying | CANDIDATE_FROZEN | writer quiescent、スコープ検証、snapshot・manifest永続化済み |
| verifying→reviewing | CHECKS_PASSED | 全必須checkがC上でpassed、出力欠落なし、ソース改変なし |
| verifying→changes_required | CHECKS_FAILED | failed/timeout/unknown/計画改変を検出 |
| reviewing→awaiting_approval | REVIEWS_PASSED | review gate合格、必要family数、coverage、指摘処置が揃う |
| reviewing→changes_required | REVIEWS_FAILED | blocker・high未解消、invalid/incomplete、coverage不足 |
| awaiting_approval→integrating | INTEGRATION_AUTHORIZED | 有効approval、同一digest、最新ref=B、active writerなし |
| integrating→integrated | INTEGRATION_CONFIRMED | Git ref=Cを観測し、journalとDBを確定 |
| awaiting_approval→changes_required | CANDIDATE_INVALIDATED | 仕様・policy・evidence・baseの変化。approvalを同transactionでrevoke |
| integrating→changes_required | BASE_MOVED | CAS不成立。自動で別baseへ統合しない |
| changes_required→ready | REVISION_REQUESTED | 人間または許可されたrepair予算内、generation増加 |
| failed→ready | RETRY_AUTHORIZED | 旧writerの終了を確認、原因と再試行回数を記録 |
| active→recovery_required | EXECUTION_UNCERTAIN | daemon/worker切断・出力欠落など成功/停止を確定できない |
| recovery_required→ready | RECOVERY_RETRY_AUTHORIZED | 旧worker終了とworkspace保全を確認、generation増加 |
| quiescent→cancelled | CANCEL_CONFIRMED / CANCEL_QUIESCENT | active writerなし。履歴・branchは保持 |

`CANCEL_REQUESTED` は直ちにterminal stateへ遷移させない。attemptをstoppingにして中断し、確認できた後に `CANCEL_QUIESCENT` を発行する。

`APPROVAL_GRANTED`、`APPROVAL_REVOKED`、`MESSAGE_APPENDED`、`HERDR_STATUS_OBSERVED` はeventとして記録するが、単独ではtaskを進めない。`integrated` はterminalであり、追加修正は別taskを作る。

## 5.4 Attempt状態

```text
created → starting → running ⇄ waiting_input → stopping
                       │              │           │
                       ├─ completed   ├─ failed   └─ cancelled
                       └─ failed
通信断・identity不明・結果不明 → unknown
```

completedは「この実行が正常終了」であり、レビュー合格・統合済みではない。nativeの場合、exit codeだけで成功にせず人間のfinish要求も必要。`unknown` はactive writer uniquenessの対象に残る。

## 5.5 SQLite構成

本番DBはdaemonだけが開く。workerとCLIはIPCを通し、`sqlite` ファイルを直接書き換えない。初期化時は以下を実行する。

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

ローカルfilesystemのみをサポートする。NFS、SMB、同期ドライブ上にDBを置かない。[S6] SQLiteの実versionを `SELECT sqlite_version()` で確認する。WAL-reset問題の修正を含む **3.51.3以上** を本設計の本番最低値とする。古いbackport版の例外判定は初版で行わない。[S6]

本配布物の検証スクリプトはDDLと論理制約の検査であり、実行環境のSQLiteが本番最低値に達していることまで示すものではない。

### テーブルの用途

| テーブル群 | 用途 |
|---|---|
| repositories/config_versions | 登録repo、trusted設定のスナップショット |
| tasks/task_dependencies | 業務状態と依存DAG |
| workspaces/attempts/leases | 実行環境・writer排他・プロセスidentity |
| commands/events/worker_offsets | 要求冪等性、outbox、再配送の重複除去 |
| artifacts/artifact_links | 内容アドレスによる証拠と参照 |
| candidates/checks/reviews/findings/finding_dispositions | 同一候補に対する評価 |
| approval_requests/approvals/integrations | 承認と外部副作用 |
| boards/board_seats/board_rounds/board_posts/board_access_grants | 討論と公開境界 |
| handoffs | 引き継ぎ元と引き継ぎ先 |

### migration

初回はDB作成後、migration全体をtransaction内で適用し、SQLファイルのSHA-256を `schema_migrations` へ記録する。起動時に同じversionのchecksumが変わっていれば停止する。migrationは番号順、原則forward-only。更新前に整合バックアップを取る。新しいDB schemaを古いバイナリで開いたら `SCHEMA_TOO_NEW`。

## 5.6 コマンド処理と冪等性

外部副作用を伴う要求は `requestId` を必須にする。CLIは一回のユーザー操作につきUUIDを作り、通信再試行では同じIDを使う。

1. パラメータを検証し、canonical digestを計算。
2. `BEGIN IMMEDIATE`。
3. 同じrequestIdがあれば、paramsDigestが一致する時だけ既存結果/進行状態を返す。不一致は `IDEMPOTENCY_CONFLICT`。
4. `expectedVersion` とtask.versionを比較。
5. domain guardを評価。
6. commands行、必要なstate更新、events行を同transactionで記録。
7. COMMIT。
8. executorがcommandsを実行し、結果を別transactionで確定する。

Git・プロセス起動・ネットワーク待ちをDB transactionの中で行わない。長いtransactionでdaemonをブロックしない。

**重要:** APIのidempotency keyだけで、LLMへの送信がexactly onceになるわけではない。`turn/start` を送った直後に接続が切れ、受理されたか不明なら、履歴や現active turnを照合する。照合できなければuncertain。新しいturnを盲目的に開始しない。

## 5.7 eventとspool

workerはローカルの `events.jsonl` に、`sourceSeq=1,2,...` を付けて順番に追記する。各行は一つのJSON。正常終了・承認要求・候補に関わる境界では必ずfsyncし、message deltaは最大1秒のbatch flushを許可する。partial trailing lineは復旧時に隔離する。

daemonの受理手順:

- `(attemptId, sourceSeq)` をunique keyとして重複排除。
- `workerInstanceId` が一致しなければ `WORKER_IDENTITY_MISMATCH`。
- 次に期待するseqより大きい場合はgapとして保存待ちにし、workerへ欠けた範囲のreplayを要求。
- 過去seqは既に保存したpayload digestと比較。一致ならack、違えば改ざんまたは実装不具合として停止。
- contiguous seqだけをstate reducerへ渡す。
- terminal event後に到着したdeltaは履歴には残しても状態を巻き戻さない。
- events.seqはdaemon側の総順序、sourceSeqはworkerごとの順序。混同しない。

journal容量上限に到達したらworkerは生成を中断し `LOG_CAPACITY_EXCEEDED`。証拠を失いながら無制限に実行しない。

## 5.8 artifact store

```text
$AW_HOME/
  db/state.sqlite
  objects/sha256/ab/<remaining62hex>
  repos/<repoId>.git/
  workspaces/<repoId>/<workspaceId>/
  workers/<attemptId>/{ticket.json,events.jsonl,worker.sock,identity.json}
  exports/
  protocol-captures/<captureId>/
  backups/
  control.sock
  daemon.lock/
```

$AW_HOMEはLinuxでは `$XDG_STATE_HOME/agent-workbench` または `~/.local/state/agent-workbench`、macOSでは `~/Library/Application Support/agent-workbench`。`--home` で明示できる。socketパス長のOS上限に近づく場合はUID専用短縮runtime directoryへsocketだけ置く。通常ファイルへSymlinkを張って回避しない。

artifact保存は、同filesystem上の一時ファイルへ `O_CREAT|O_EXCL`、サイズ制限、hash計算、fsync、atomic rename、directory fsync、DB参照登録の順。DB登録前にクラッシュしたobjectは孤立objectとして後日GCできる。DBから参照されたobjectが無い場合は検証失敗。内容が同じobjectを上書きしない。

## 5.9 canonical-json-v1

利用するJSONは、null / boolean / safe integer / string / array / objectだけ。estimateなどの小数はLLM出力artifactの生bytesとしてhashし、canonical identityへ直接入れない。object keyはASCIIに制限し、辞書順にsortする。string値はUTF-8、Unicode正規化なし。array順序は保持する。集合を表すarrayは呼び出し側でID順にsortする。

```typescript
export function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("NON_CANONICAL_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    if (keys.some(k => !/^[\x20-\x7e]+$/.test(k)))
      throw new Error("NON_ASCII_OBJECT_KEY");
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  throw new Error("NON_CANONICAL_VALUE");
}
```

入力parserは重複keyを拒否する。標準 `JSON.parse` だけでは重複keyを識別できないため、ユーザー入力と署名対象のロードにはduplicate-key検出を持つscannerを前置する。depthは64、1 objectのkeyは10,000、1 frameは8MiB。このscannerにもfuzz testを用意する。


---

# 6. 実行ドライバと外部APIの統合

## 6.1 Adapter境界

外部APIは直接domainへ流さない。以下はaw内部のinterfaceであり、外部製品のAPIではない。

内部interfaceの正本は `contracts/ports.ts`。AgentDriverの入口は `probe / startFresh / events / steer / interrupt / readPublicHistory / close`、PresentationDriverは `startManaged / startNative / attach / getStatus / closePresentation` とする。`startFresh` はsession作成と最初のturn開始をまとめた内部operationで、後続入力をどう扱うかはdriver内のsession controllerが管理する。

domain側は `AgentRequest`、`SessionHandle`、`AgentEvent`、`CheckRequest`、`CheckResult` を使用し、外部のCodex型・Herdr型をdomainへimportしない。`ports.ts` は単独でtypecheck可能な宣言であり、外部wire型はcaptureしたschemaから生成する。


`native` はAgentDriverを経由しない。PresentationDriverがCodex CLIを起動し、後段のvalidation pipelineへsnapshotを渡す。`headless` と `native` のnative session IDが同じ場合は二重所有として拒否する。

## 6.2 対応版の決め方

人手でCodex/Herdrの最新APIを模写して維持しない。利用バイナリ自身からprotocolを取得し、compatibility lockを作る。[S1][S3]

```bash
codex --version
codex app-server generate-ts --out ./protocol-capture/codex-ts
codex app-server generate-json-schema --out ./protocol-capture/codex-json
herdr --version
herdr api schema --output ./protocol-capture/herdr.schema.json
git --version
node --version
```

これらは既存製品の公式コマンドである。生成物を取り込むビルド用scriptでは、実行ファイルの絶対パス、version出力、生成ファイル一覧とSHA-256を記録する。

`compatibility-lock.json` の最低フィールド:

```json
{
  "schemaVersion": 1,
  "codex": {
    "version": "captured-at-build",
    "binarySha256": "captured-at-build",
    "schemaSha256": "captured-at-build",
    "bridgeVersion": 1
  },
  "herdr": {
    "variant": "tui",
    "version": "captured-at-build",
    "schemaSha256": "captured-at-build",
    "bridgeVersion": 1
  }
}
```

上記文字列は形式説明用で、そのままproductionで受理しない。実値はcaptureで埋める。未知versionは自動で対応済みにせず、contract testを実行してからlockを更新する。model catalogの存在はアカウントの利用権保証ではないため、明示承認された小さなsmoke turnの成功で利用可否を確認する。

### R1の必要capabilities

Codex: stdio App Server、initialize、thread/start、turn/start、turn/completed、turn/interrupt、structured output、sandboxed command/exec。厳格隔離ではrestricted readが追加必須。

Herdr TUI: workspace.create、pane識別、pane input/run、pane/process情報、agent.start（native用）、agent.get、snapshotまたは同等の一覧照合。表示metadataは任意。欠けていれば `presentation=none` へ人間の選択で変更する。無断のfallbackはしない。

## 6.3 Codex App Server接続

workerが絶対パスのCodex binaryを `spawn(binary, ["app-server"], {shell:false,...})` で起動する。stdin/stdoutをprotocol用pipe、stderrを診断logとして分離する。親が読み出しているstdoutへ独自ログを混ぜない。

接続の基本順序:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent-workbench","title":"Agent Workbench","version":"0.1.0"}}}
{"method":"initialized","params":{}}
{"id":2,"method":"thread/start","params":{"cwd":"/absolute/workspace","model":"CONFIGURED_MODEL"}}
```

実際にはinitialize応答を待ってからinitializedを送る。`CONFIGURED_MODEL` は選択済みprofileのmodelIdで置換する。threadの設定をそのまま信用せず、turn開始時にpermission envelopeとoutput schemaを明示する。

```json
{
  "id":3,
  "method":"turn/start",
  "params":{
    "threadId":"RETURNED_THREAD_ID",
    "input":[{"type":"text","text":"HOST_BUILT_TASK_PACKET"}],
    "cwd":"/absolute/workspace",
    "approvalPolicy":"on-request",
    "sandboxPolicy":{
      "type":"workspaceWrite",
      "writableRoots":["/absolute/workspace"],
      "readOnlyAccess":{
        "type":"restricted",
        "includePlatformDefaults":true,
        "readableRoots":["/absolute/input-packet","/absolute/managed-repo.git"]
      },
      "networkAccess":false
    },
    "outputSchema":{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}
  }
}
```

上記はwire形の説明で、最終実装ではgenerateした型に `satisfies` を付けてコンパイルする。実際のoutputSchemaはtaskのroleに対応する契約を使う。readableRootsは必要なコード・入力・Git object領域だけを与え、$AW_HOME全体を渡さない。実際のsandbox挙動はdoctorのcanary試験が前提であり、このJSONを送っただけで隔離成立と記録しない。

`thread/fork` は履歴を引き継ぐため、独立レビューやBoardの初期席作成には使わない。常に新しい `thread/start` を使う。修正作業やHandoffは文脈継続の目的があるため、独立性要件のない経路でだけresume/forkを検討する。

## 6.4 frame parserとイベント処理

- UTF-8をchunk境界で壊さないためStringDecoderを使う。
- newlineごとにframeを分け、最大8MiB。上限を超えたら停止する。
- `id` ありかつ `method` なしはresponse、`id` と `method` はserver request、`method` のみはnotification。
- pending request mapはconnection epochとrequest IDで管理する。
- request応答timeoutは標準30秒。生成自体のtimeoutとは分ける。
- first-progress warningは120秒、hard deadlineはTaskSpecのwallTimeSeconds。
- 未知notificationはraw journalに記録し、状態遷移に使用しない。
- 未知のserver requestは自動承認しない。安全なエラー応答を返しturnを中断する。
- protocol malformed、stdoutに不正ログ、型不一致は `PROTOCOL_VIOLATION`。
- pipe終了時にpending promisesをすべてrejectする。
- stderrに認証token、URL query内secret、環境値が含まれてもUIへそのまま出さない。

deltaは表示専用。構造化最終出力は完了itemの確定本文から取り出す。streamを適当に連結して最初の `{` からJSONを切り出す実装は禁止する。

## 6.5 Codexの完了・中断・承認

`turn/completed` のturn.statusがcompletedであることを確認したうえで、role別schemaとsemantic validatorを通す。failed/interruptedは成功ではない。正常終了でもJSON不正、coverage欠落、tool failureが未処置ならreviewはincompleteにする。

業務上の追加指示は、実行中なら対応capabilityがある場合だけ `turn/steer`、idleなら次の `turn/start` を使用する。steerには現在のexpectedTurnIdを付ける。古いturnへ送らない。送信中に切断したら履歴と照合するまで自動再送しない。

承認要求はworkerからdaemonへ正規化して、次を表示する。

```text
attempt / native thread / native turn / native request ID
要求種別、command argvまたはfile change、cwd、追加権限
許可範囲、候補に与える影響、expiresAt、現在のrequest状態
```

permit結果はserver request IDに対して一回だけ返す。原則はturn限定。未知範囲への書き込み、`dangerFullAccess`、hostの秘密情報読取、統合ref変更、control socket操作は拒否する。権限を増やす場合は人間の明示操作とpolicy改訂を必要とし、既存candidateの評価を無効にする。

プロトコルにある `process/spawn` や `thread/shellCommand` を安全なcommand runnerの代用にしない。これらとsandboxed `command/exec` の権限境界は異なる。[S1] 初版bridgeは前二者をexposeしない。

## 6.6 管理workerとHerdr

### managed起動

1. daemonがattempt、writer lease、ticketを永続化する。
2. Herdrへ専用workspaceを `cwd=<writer checkout>` で作成する。
3. responseからworkspace ID、tab ID、pane ID、terminal IDを記録する。
4. 使用者のコードやpromptを含まない固定launcherをペインで実行する。
5. workerがticketのattemptIdとnonceを検証し、自分のsocketを開く。
6. daemonがworkerへchallenge-responseしてidentityを確認する。
7. workerがApp Serverを起動、protocol初期化、journalへworker.readyを保存。
8. daemonがtaskをrunningへ進める。

launcher文字列は `exec '<absolute-node>' '<absolute-worker-script>' --ticket '<absolute-ticket-path>'` の固定構造とする。POSIX single-quote escape関数を実装・テストし、NULとnewlineを含むpathを拒否する。自由文promptはticketから読み、shellへ渡さない。launch後のticketはone-shot化し、同じticketを再実行しても既存workerへ接続するか失敗するだけで二重起動しない。

Herdrがない経路ではdetached workerを直接起動し、標準入力を閉じてjournalを使う。親CLIを閉じてもworkerが消えないことをE2Eで確認する。

### native起動

Herdrの専用空きペインに対し `agent.start` を使う。現行Rust schemaでは `name`、`kind`、`pane_id`、`args`、`timeout_ms` が定義されている。[S4]

```json
{
  "id":"native-start-1",
  "method":"agent.start",
  "params":{
    "name":"aw-0123456789ab",
    "kind":"codex",
    "pane_id":"w1:p1",
    "args":["--sandbox","workspace-write","--ask-for-approval","on-request"],
    "timeout_ms":30000
  }
}
```

このnameは短縮IDで32文字以内、衝突時は再採番する。full taskIdは独自DBに保持する。起動確認後、`agent.prompt` でホストが生成した開始packetだけを送る。その後は利用者が直接対話する。native実行中の `aw task send` は明示的にinteractive扱いであり、自動キューを勝手に流さない。

### 観測上の注意

Herdrのprompt成功はキー入力送信の成功で、Codex turnの成功ではない。waitは個別turnの結果やtest成功の保証ではない。[S2] `terminalId`、paneId、occupant、cwdを組み合わせ、別プロセスに置き換わったペインへ指示しない。

metadataを使える場合、`aw_task`、`aw_phase`、`aw_gate`、`aw_risk` のみを表示する。機密タイトルやエラー全文をwindow titleへ載せない。metadataはTTL付きの表示補助であり、消えてもDB状態は失われない。

## 6.7 Herdr再接続

event購読はキャッシュ無効化の通知として使い、完全なevent-sourcingログとは扱わない。再接続時はsubscribeした後にsnapshotを取得し、個別getで現在のterminal identityを照合する。[S3]

- workspaceがある、workerが生きている: 表示を再接続。
- workspaceがない、workerが生きている: 新しいmonitorペインだけを作る。
- workspaceがある、workerが不明: 復旧待ち。新規writerは作らない。
- server/host再起動: 元のprocessが存続したと仮定しない。native session resumeの可否とコードのquiescenceを再判定する。

`server.stop`、他人のworkspace close、全セッション削除はawから実行しない。

## 6.8 Gemini Adapter

R2の別提供元経路はGemini RESTで実装する。Claude Codeは不要。APIキーはworker自身の秘密設定から取得し、promptやenvironment dumpに出さない。利用modelIdはprofileで固定し、モデル一覧と実際の利用可否を確認する。特定のモデル名をコードにハードコードしない。[S8]

HTTP clientはNodeのfetchを使い、公式generateContent endpointへJSONを送る。構造化出力はそのmodelが対応するJSON Schemaの部分集合へ変換する。original schemaのAjv検証を省略しない。[S7] `responseMimeType`、JSON Schema field、token制限のwire名は公式REST契約のcaptureとcontract fixtureで固定する。

Gemini Adapterの初版は **テキスト入力・テキスト出力のみ**。OSファイルアクセス、shell tool、独自browser toolを与えない。hostがallowlistしたcode packet、仕様、diff、事実検証結果だけを入力する。これによりBoardのblindnessを共有filesystemに依存せず実装できる。

HTTP 401/403は認証/許可エラーとして停止。429/503はRetry-Afterを尊重し、最大3回、全体deadline内だけ再試行する。これは計算結果の重複課金可能性を消すものではない。本文受理後の切断はusage unknownとして残す。安全フィルタ拒否、空candidate、長さによる切断、JSON不正は正常完了としない。

## 6.9 汎用外部Provider plugin

初版は任意のnpm packageを動的ロードしない。将来のprovider追加はtrusted executable adapterとして分離する。stdin/stdoutの独自JSONL契約で、hello/capabilities、start、interrupt、event、finalを定義する。実行パス・binary hash・送信先を人間が登録する。pluginがtrainingFamilyを自由に詐称してgateを満たさないよう、provider/family registryはtrusted policy側が所有する。

## 6.10 Herdr Core `hc`

`hc` はHerdr TUIのコマンド別名として扱わない。Herdr Coreは別のruntimeとして公開されている。[S9] 初版は `herdr-tui` のみ実装し、Coreを検出したら `PRESENTATION_VARIANT_UNSUPPORTED` を出す。将来 `HerdrCorePresentationDriver` を追加しても、task/candidate/gate/DB schemaは変更しない。未検証の `hc` フラグを推測で使ってはいけない。


## 6.11 Gemini adapterの具体的wire contract

この設計の `gemini-api` は **generateContent REST経路**を選択する。Interactions APIと混在させない。公式structured outputガイドにはInteractionsの例もあるため、そこにある `response_format` をgenerateContentへ送らない。[S7][S8]

```http
POST https://generativelanguage.googleapis.com/v1beta/models/{configuredModel}:generateContent
Content-Type: application/json
x-goog-api-key: <credential supplied by host>
```

```json
{
  "systemInstruction":{"parts":[{"text":"HOST_VERSIONED_REVIEW_INSTRUCTIONS"}]},
  "contents":[{"role":"user","parts":[{"text":"HOST_BUILT_ALLOWLISTED_PACKET"}]}],
  "generationConfig":{
    "candidateCount":1,
    "maxOutputTokens":8000,
    "responseMimeType":"application/json",
    "responseJsonSchema":{
      "type":"object",
      "properties":{"summary":{"type":"string"}},
      "required":["summary"],
      "additionalProperties":false
    }
  }
}
```

modelは許可済みcatalog entryだけをURL componentとしてencodeする。任意URL/baseUrlをTaskSpecから受け取らない。API keyはquery stringへ入れずheaderで送る。上記schemaは説明用で、実際にはReviewOutputまたはBoardPostをAPIの対応subsetへ変換して使用する。`$schema` / `$id` などのmetadataは送信payloadから除くが、hostの完全なschema検証は緩めない。providerが拒否するunsupported constraintを無断削除して成功扱いにせず、対応表とcontract testを更新する。

`candidates[0].content.parts` の公開textのみを収集し、`finishReason` が通常終了であること、候補数、prompt block、tool call不在を検査する。MAX_TOKENS、安全性によるblock、text欠落はincomplete。responseのunknown fieldsは保存してよいがgate判定には使わない。

multi-round Boardも、hostが選んだ公開済み過去投稿だけをcontentsへ再送するstateless方式でよい。private server conversationの有無に依存せず、席ごとの独立性と公開順序をhostが管理する。初版は検索・code execution等のtoolsを渡さない。検証実験は別の許可済みCheckRunnerで行う。


---

# 7. Git・worktree・候補コミット・統合

## 7.1 元repositoryとmanaged repositoryを分ける

元repositoryのcurrent branchは、利用者のIDEや別のCodexが同時に触る可能性がある。そこへ `reset`、自動checkout、直接 `update-ref` を実行しない。

```text
~/src/ugo_hub                       # 元repository。awは読み取り
$AW_HOME/repos/<repoId>.git         # awが管理するbare repository
$AW_HOME/workspaces/.../<wsId>/     # タスク・検証用のlinked worktree
```

Git worktreeは同一repositoryのobject/refを共有する。[S5] **worktree分離はファイル競合の分離であり、セキュリティ境界ではない。** managed repositoryを別にするのは、利用者のcheckoutと実行基盤の制御を切り離すためである。

### 登録アルゴリズム

1. `realpath(sourcePath)` を取得し、directory、同一UIDの所有、明示指定refを検証。
2. `git -C source rev-parse --show-object-format` でSHA-1/SHA-256を確認。
3. `git -C source rev-parse --verify <fullBaseRef>^{commit}` でsource base Oを固定。
4. `git init --bare --object-format=<format> <managedPath>`。
5. managed repositoryへ指定base refだけをfetchする。全branchや作業中の未コミット変更をコピーしない。
6. 取得したOIDがOに一致することを確認。一致しなければsource変更を通知し再計画。
7. `refs/aw/source/base` と `refs/heads/aw/integration/<repoId>` をOへ設定。
8. SQLiteへ登録し、生成したpathと参照をログに残す。
9. 元repositoryのstatus、HEAD、指定base refが変わっていないことを確認。

元repositoryは取得中に別プロセスが変更し得るため、前後比較の不一致を「awが変更した」と即断しない。ただし一貫したbaseを確定できない登録は再試行対象にする。

### Git実行の環境

全操作は `spawn("git", argv, {shell:false,...})` で行う。LLMが作ったshell文を実行しない。trusted Git wrapperは次を設定する。

- `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL` を空の管理ファイルへ向ける。
- `core.hooksPath` を空の管理directoryへ向け、repository hookを実行しない。
- `core.fsmonitor=false`、`core.pager=cat`、`GIT_TERMINAL_PROMPT=0`。
- PATHはdoctorで確認したtrusted executableのdirectoryだけ。
- Git commandのstdout/stderrのbytes上限とtimeoutを設ける。
- ソースの `core.sshCommand`、外部diff、textconv、credential helper、global aliasを引き継がない。
- `safe.directory=*` を設定しない。ownership問題は登録時に停止する。
- network fetch/pushはR2標準では行わない。ローカルsource importのみ。

ローカルsourceの読取にfile protocolが必要な場合も、指定source pathに対する当該コマンドだけで許可する。永久のglobal設定は変えない。

## 7.2 worktree割当

初版は再利用poolを作らない。新しいworkspace IDごとに新しいdirectoryを作る。この方針で初期実装から、古い未マージbranchの破壊やslot再利用による誤mergeを排除する。

```bash
# B, branch, pathはdaemonが検証済みの値。任意のLLM文字列ではない。
git --git-dir "$MANAGED" worktree add \
  -b "aw/tasks/$TASK_ID/$GENERATION" "$WORKSPACE" "$B"
```

Bはrepository.integration_shaの、その時点の固定OIDである。`HEAD`、`develop`、`origin/develop` を後から再解決して作業基点に使わない。

割当はDBのreserved行→Git add→現物検査→readyのsagaにする。Git add成功後にdaemonが落ちても、worktree listのmachine-readable出力と既知path・branch・baseで照合する。一致していれば処理を継続、不一致ならquarantine。

### 割当時のチェック

- pathが許可されたworkspace root配下で、symlinkを経由しない。
- pathが存在する場合は空でも勝手に消さず、既知operationの続行かを確認。
- branch名はhostがIDから生成し `git check-ref-format` に通す。
- `.git` pointerが登録したmanaged git-dirへ向いている。
- `HEAD == B`、dirtyでない、想定外のsubmodule状態がない。
- registryとfilesystemの両方にactive writerがいない。
- native sessionを再利用する場合もcwdを照合し、古いworkspaceへ戻っていない。

## 7.3 writer排他とfencing

一つのworkspaceについて、SQLのpartial unique indexとlease epochを併用する。daemonは単一writerだが、外部workerは生き残るためepochを使う。

```text
lease(resource="writer:<workspaceId>", ownerAttempt=A, epoch=7)
```

workerの全報告にattemptIdとworkerInstanceIdを付ける。古いepochの完了報告は候補固定を起動しない。ただしepochを増やしても古いOS processが物理的に書き込めなくなるわけではない。旧workerの終了確認なしに新writerを開始してはいけない。

heartbeatは5秒、観測上の失効は30秒を初期値とする。30秒経過だけでlockを解除しない。PIDだけで生存確認しない。process start identity、worker socket handshake、Herdr terminal identity、boot identityを照合し、判断できなければrecovery_required。

## 7.4 実装者に許すGit操作

managed経路の実装者にはファイル編集と読取中心の作業をさせ、commit、branch変更、push、merge、rebaseを必要としないpromptにする。候補commitはhostが生成する。

Codexのworkspace-writeにおける `.git` 保護は利用できるが、その効果は導入版と実機で確認する。[S10] 実装者がGit metadataの書き込み許可を求めても、候補作成のためという理由だけでは許可しない。

native経路で利用者がcommitを作った場合も、そのcommitが統合対象とは限らない。awは最終treeを候補として再構成し、nativeの履歴と参照は保全する。

## 7.5 候補固定の厳密な手順

前提は「Codexがreadyと言った」ではなく、writerが停止していること。

1. 新規入力を停止する。
2. 現turn完了後、workerがApp Serverとその管理下プロセスを正常終了させる。
3. 残存子プロセス・背景ターミナル・書き込み中のtoolが無いことを確認する。不明なら凍結を中止する。
4. nativeではユーザーがCodexを終了し、専用paneのforegroundがshellへ戻ったことを確認する。未知のbackground processを見つけたら停止を依頼する。
5. worktreeのHEAD、tracked変更、untracked file、file mode、symlink、gitlinkを収集する。
6. 変更pathをTaskSpec.scopeとtrusted policyで検証する。外部へ向いたsymlink、絶対path、`..`、NUL、改行、曖昧なcase衝突は拒否する。
7. secret scan、巨大binary、LFS pointer、submodule差分を判定する。
8. private indexを作り、base Bから最終treeをステージする。
9. tree Tを作り、Bを唯一のparentとするcandidate commit Cを作る。
10. manifestとcandidate identityを保存する。
11. candidateを到達可能にするprivate refを作る。
12. 元workspaceの変更集合を再確認し、凍結中の変更があればCを評価対象にせず再凍結する。
13. candidateとtask遷移をtransactionで確定する。
14. Cから新しいcheck/review checkoutを作る。

### private indexの実装

`GIT_INDEX_FILE` は既存ファイルではなく、管理側で確保した一意なpathを使う。

```bash
GIT_INDEX_FILE="$PRIVATE_INDEX" git --git-dir "$MANAGED" \
  --work-tree "$WORKSPACE" read-tree "$B"

GIT_INDEX_FILE="$PRIVATE_INDEX" git --git-dir "$MANAGED" \
  --work-tree "$WORKSPACE" add -A -- .

GIT_INDEX_FILE="$PRIVATE_INDEX" git --git-dir "$MANAGED" write-tree
# => T

# messageはstdinから渡す。B,Tは検証済みOID。
printf '%s\n' "$TRUSTED_COMMIT_MESSAGE" |
  git --git-dir "$MANAGED" commit-tree "$T" -p "$B"
# => C
```

上記はアルゴリズムを示すshell表現。実装は各argvをspawnし、messageだけstdinへwriteする。`git add` の前にpath/secret検査を完了する。ignored fileを勝手に `git add -f` しない。

author/committerは設定済みの `Agent Workbench <local@agent-workbench.invalid>` を標準とする。LLMや実在の人の署名を偽装しない。commit messageへtask ID、spec digest、実装driverを記録する。日時もhostが決め、再送時は同じcommit identityを再利用する。

### スナップショット方式を採る理由

candidateは「作業中に積み重なったcommitの列」ではなく、**承認する最終treeとbaseの組**である。初版は一つのsquash candidateに統一する。commit履歴の保存が必要な案件は元のtask branchを保持したまま、人間が別途扱う。

## 7.6 manifest

manifestは次を含む。

```json
{
  "schemaVersion":1,
  "baseSha":"<B>",
  "candidateSha":"<C>",
  "treeSha":"<T>",
  "files":[
    {
      "path":"src/example.ts",
      "change":"modified",
      "mode":"100644",
      "blobOid":"<git-oid>",
      "contentSha256":"sha256:<digest>",
      "sizeBytes":1234
    }
  ]
}
```

削除fileにはold blob情報を記録する。renameはGitのheuristicに依存し過ぎず、old/new両pathの内容を保存する。diffは `--no-ext-diff --no-textconv --binary` を用い、表示用の巨大diff打ち切りと、検証用の完全artifactを区別する。

### binary / LFS / submodule

- binary変更は自動で文章レビュー済みにしない。型別検証がなければhuman coverageが必要。
- LFSはpointerと実体を区別し、実体未取得ならcoverageをincompleteにする。network取得は別承認。
- gitlink変更はR2で自動統合しない。`UNSUPPORTED_GITLINK_CHANGE`。
- submoduleを持つrepoで対象作業に必要な実体がない場合は開始前に停止し、bootstrapを人間が登録する。
- 差分ファイルが標準5,000個、単一変更binaryが10MiB、packetが8MiBを超える場合は自動分割計画を作り、人間に確認する。黙って一部だけ検証して合格にしない。

## 7.7 検証・レビュー用checkout

```bash
git --git-dir "$MANAGED" worktree add --detach "$CHECK_PATH" "$C"
git --git-dir "$MANAGED" worktree add --detach "$REVIEW_PATH" "$C"
```

checkは自分のcheckout内にbuild outputを書けるが、ソース変更をしたら失敗扱い。reviewはread-only、追加実験は別experiment checkoutに分ける。writerが再開しても既存Cのcheckoutは変更しない。

dirty snapshotの元writer worktreeは証拠を保持する。初版GCはdirty worktreeを自動削除しない。candidateに内容が保存されていることだけを理由に `--force` で消さない。

## 7.8 統合アルゴリズム

統合先はmanaged bare repo内の `refs/heads/aw/integration/<repoId>` だけ。ユーザーのchecked-out branchは対象外。

```text
prepare:
  validate current candidate + gate
  verify approval binding and expiry
  verify target ref currently B
  verify B ancestor of C; candidate parent is B
  ensure target ref is not checked out in any worktree
  persist integration(prepared) and reserve approval for commandId

apply:
  git update-ref -m "aw:<integrationId>" <targetRef> <C> <B>

confirm:
  read target ref
  if C: integration applied, approval consumed, task integrated
  if B: not applied; inspect command outcome, retry same operation when safe
  otherwise: uncertain/base moved; never overwrite
```

expected-old-SHA付きupdate-refがCASになる。[S11] 「checkしてから引数なしでupdate-ref」では競合を防げないため禁止する。

DBのpreparedとGit更新の間、Git更新とDB確定の間にクラッシュする試験を必須にする。Git ref=Cなら同じoperationの実行済みとして再構成できる。unknownな別SHAなら人間確認。失敗したからといって自動でrefをBへ戻さない。

## 7.9 他タスクが先に統合された場合

task A/Bが同じbase Oから分岐し、Aの候補CAが先に統合されると、Bの承認はexpectedBase=Oなので使えなくなる。

Bには新generationを作り、CAを基点にBの変更を適用し直す。conflictは実装者が解消する。新candidate CB2に対してcheck・review・approvalをすべて取り直す。差分が似ていること、treeの一部が同じこと、patch-idが同じことを根拠に古い承認を転用しない。

## 7.10 source syncとexport

`aw repo sync` は元repositoryの指定baseを読み直す。managed integration tipが新source tipのancestorならfast-forward計画を提示できる。divergeした場合は既存成果を破棄せず、手動の統合計画が必要。動いているtaskのbaseを暗黙に変えない。

`aw task export --format git-bundle` は候補refをbundle化し、元baseをprerequisiteとして記録する。書き出した後に `git bundle verify` を行う。利用者のrepositoryへ取り込む手順例は次の通り。

```bash
git -C ~/src/ugo_hub bundle verify /absolute/change.bundle
git -C ~/src/ugo_hub fetch /absolute/change.bundle \
  refs/aw/candidates/<taskId>/<generation>:refs/heads/aw-import/<taskId>
# この時点ではdevelopは変わらない。以後のmerge/PRは利用者が判断する。
```

source branch名とbundle内ref名はexport結果JSONに正確に出力する。利用者へ推測で入力させない。

## 7.11 GitHub draft PR拡張

R2の必須ではない。実装する場合は `publish` を `integrate` と別scopeの承認にする。publish workerだけがGitHub資格情報へアクセスする。LLM・チェックrunnerへtokenを渡さない。

公開先repo、base branch、head branch、candidate SHA、draft=true、送信する本文digestを承認に含める。branchは新規作成を原則とし、force push禁止。通信断後はremote branch SHAとhead branchに紐づく既存PRを読み、同じ公開処理かを照合する。API呼び出しの再送だけで二重PRを防げると仮定しない。PR mergeは別機能として未提供にする。


---

# 8. 検証・独立レビュー・承認ゲート

## 8.1 三つの「完了」を分ける

1. **runtime completed:** providerが一回の実行を終了した。
2. **candidate verified:** 候補Cについて必要なcheckとreviewが揃った。
3. **integration applied:** 人間が承認したCが、指定のmanaged refへ反映された。

この三つは別のstateである。実装者の `testsClaimed`、Herdrのdone、自然言語の「問題なし」を2または3へ直接変換しない。

## 8.2 CheckPlan

ProjectPolicyのcheck allowlistをhostが読み、TaskSpec.checkIdsとrisk rulesの和集合からrequired planを作る。TaskSpecから自由なshell commandを注入できないよう、taskが指定するのはcheck IDだけにする。

各checkは `argv[]`、相対cwd、timeout、env allowlist、network policy、期待artifact、必須/任意を持つ。cwdはcandidate checkout内でrealpath検証する。`argv[0]` はdoctorで確認したtrusted executableに解決し、実際の絶対pathとversionをenvironment manifestへ保存する。

`["sh","-c", userText]`、`eval`、`source` のような汎用shell実行を標準allowlistに置かない。既存npm scriptの実行は、そのscriptを定義するpackage.jsonとlockfileを含めて信頼する操作であり、「pnpmだから安全」ではない。

## 8.3 検証の実行

R1のcheck runnerは、LLM turnを作らず、**独立したCodex App Serverのsandboxed `command/exec`** を使用する。[S1] App Server processを検証専用の空のCODEX_HOMEと最小environmentで起動し、GitHub/AWS/Gemini等の資格情報を渡さない。checkにはモデル推論は不要である。利用版でこの経路が成立しなければdoctorで非対応にする。unsafeなhost spawnへの自動fallbackは禁止。

```text
candidate C checkout
 → bootstrap（必要なら、別途信頼されたコマンド）
 → HEAD/tree/環境を記録
 → command/exec(argv, cwd, sandbox, timeout)
 → outputとexitをhostが記録
 → tracked sourceがCから変化していないことを確認
 → expected artifactsを収集・hash化
 → check resultを保存
```

bootstrapは依存取得用networkを必要に応じて許可するが、宛先を明示する。package install scriptsは標準で無効にし、native buildが必要な特定パッケージだけ人間が許可する。`pnpm install --frozen-lockfile` を必須とし、lockfileが無ければ再現性不足としてpolicy側で明示処置する。

checkは、exitCode=0、signal=null、timeout=false、protocol正常、required artifact取得済み、source改変なしのすべてを満たした場合だけpassed。ログ上限超過、runner crash、result不足はunknown/failedにする。出力の最後が「All tests passed」であっても判定に使わない。

実行中のformatterやgeneratorがtracked fileを変更したら、check側でその変更を採用しない。実装者へ戻し、新candidateを作る。

## 8.4 テスト自身の改変に対する扱い

エージェントがテストを削除・弱体化してexit=0を得る可能性は、汎用runnerだけでは排除できない。この設計では以下を要求する。

- package.jsonのscripts、test config、既存test削除、snapshotの大量更新、skip追加をrisk分類の対象にする。
- required command setは、candidate内の設定ではなくtrusted policyから決める。
- コマンドが呼ぶscript本体が変更された場合、変更されたことをレビューpacketと承認画面へ必ず表示する。
- framework別にtest count/assertion countを取得できる場合、基準からの減少をwarningまたはblockにする。
- test countを取得できない汎用commandを「テスト網羅性も保証」と表示しない。
- modelによる追加実験は別experiment workspaceで行う。候補C自体を変更しない。

## 8.5 レビューpacket

各reviewerへ渡す共通packetはhostが作り、hashを固定する。

```text
contract-version
task objective / out-of-scope / requirements with IDs
candidate identity
base B + candidate C + changed-file manifest
complete diff artifacts and file access instructions
API compatibility requirements / repository constraints
check plan and host-observed results
coverage obligations
untrusted-data boundary notice
output schema
```

**渡さないもの:** 実装者の「この設計で正しい」という説明、実装者の長い会話、他reviewerの回答、作成途中のBoard意見。実装意図が必要なら、要求仕様や既存ADRなど共有された原資料から与える。

初回レビューでは新threadを使う。reviewerにはread-only rootだけを渡し、候補の修正をさせない。修正案を要求できても、writerへは別stepで渡す。

## 8.6 Reviewerの評価契約

`review-output.schema.json` に従う。特に以下を必須にする。

- 指摘には具体的なclaim、破綻する条件、reproduction、根拠、該当要求IDを持たせる。
- severityは影響と発生条件で判定する。モデルの自信度だけで重大度を上げない。
- `demonstrated` はhostが実験結果を照合できた場合だけ確定する。モデルの自己ラベルはadvisory。
- 変更した全fileのcoverageを提出する。省略は未確認として扱う。
- 全requirementのcoverageをsupported/contradicted/unknownで提出する。
- evidenceのpath/lineがcandidateに存在するかhostが検証する。
- 存在しないcheck ID、別candidateのartifact、範囲外のsourceを根拠にしたらinvalid。
- 「何も見つからなかった」と「十分に確認した」は同義ではない。

structured outputが壊れた場合は、元の本文とschema validation errorを保存する。書式だけを直すretryを最大1回許可するが、壊れた値をhostが想像で補完しない。内容の変更を伴う場合は別review attemptとして記録する。

## 8.7 リスク別レビュー

| risk | 最低reviewer | 最低training family | 人間の扱い |
|---|---:|---:|---|
| low | 1 | 1 | 通常承認 |
| standard | 2 | 1 | 同一familyならその旨を明示 |
| high | 2 | 2 | 別family必須。未設定なら停止 |

これは設計上のdefaultであり、ProjectPolicyは厳しくできる。taskが緩めることはできない。実装者もOpenAI、reviewer2つもOpenAIの場合は「別セッション2件」であって「クロスベンダー」ではない。

`trainingFamily` はモデル提供元の学習系列を表すtrusted registryの値。OpenRouter経由の同じモデルを別familyに数えない。Gemini APIを登録しただけで内部コード送信を許可しない。repo.egressと明示consentが必要。

highへ引き上げる初期path例は、認証/権限、DB migration、Terraform/IAM、公開API contract、決済、データ削除、依存lockfile、CI/workflowである。実際のrepo pathはユーザー登録時に設定し、名前だけで機械的に推測した設定を有効化しない。

## 8.8 指摘の処置

指摘の識別はreview-local keyとは別にhostのfinding IDを持つ。fingerprintはcandidate跨ぎの参考対応に使うが、自動で「同じ問題は解決済み」と判定しない。

| 処置 | 許可者 | 条件 |
|---|---|---|
| open / confirmed | system、reviewer、人間 | 根拠を保持 |
| false_positive | 人間または実装者とは別のreviewer | 反証と根拠を添える |
| risk_accepted | 人間のみ | policyで許す重大度だけ。理由と範囲を記録 |
| 修正済み | 新candidateの新しい評価 | 古いfindingを削除せず、新版との関連を記録 |

blocker/highのrisk acceptは標準policyで禁止。緩めるにはpolicy変更と再評価を要する。実装者自身の「これは誤検知」は処置の提案であり、gate解除ではない。

reviewがrequest_changesでも、すべての指摘が正当なfalse_positive処置で解消され、coverageが完全ならeffective verdictをhostが再評価できる。`insufficient_evidence` は処置だけでpassに変えず、補足reviewを要求する。全review attemptと処置履歴を残し、都合のよい最後の回答だけを表示しない。

## 8.9 Gateの計算

gateは保存された真偽値を信用せず、統合の直前に再計算する。

```typescript
interface GateDecision {
  allowed: boolean;
  reasons: ReadonlyArray<{ code: string; subject: string; detail: string }>;
  candidateIdentityDigest: string;
  evidenceDigest: string;
}

function evaluateGate(facts: GateFacts): GateDecision {
  // No I/O. Return every blocking reason in stable sorted order.
  // Checks: candidate immutable; policy/spec/check plan match;
  // all required checks passed on this candidate; evidence present;
  // required reviewer profiles covered; enough real families;
  // coverage complete; no unresolved blocking findings;
  // no live writer; no pending permission escalation; budget/protocol valid.
}
```

evidenceDigestには、採用したcheck結果artifactのdigest、review結果artifactのdigest、findingsと処置、risk分類、gate rule versionを含める。配列はID順にsortしてcanonical hashにする。

新しいreview、追加のblocking finding、checkの再実行、policy更新はevidenceDigestを変える。既存approvalは同じtransactionでrevokeする。

## 8.10 Repair loop

自動修正は最大2cycleをdefaultとする。実装者へ渡すのは検証エラーと受理済みfindingであり、reviewerの非公開会話ではない。

```text
C1 → check/review失敗
  → 人間待ち、またはpolicy内のrepair
  → new generation、new writer workspace
  → C2
  → checks/reviewsを再実行
```

回数・deadline・token budgetのいずれかを超えたらchanges_requiredで停止する。無制限に「もう一度確認して」を繰り返さない。仕様自体が矛盾している場合はBoardまたは人間判断へ切り分ける。

## 8.11 承認データ

approval requestは以下のbindingをhashして作る。

```text
action
repoId / taskId
candidateIdentityDigest
evidenceDigest
targetRef / expectedBaseSha
expiresAtMs
nonce
```

nonceはCSPRNGで32 bytes。標準TTLは30分。`aw approval inspect` は要求、diffの概要、test実行数と失敗、reviewerの実model/family、未解決の非blocking指摘、送信先、対象ref、SHA、digestを表示する。

`grant` はそのdigestを明示した人間向けCLIからだけ行う。grantだけでGit操作を実行しない。`integrate` でgateとbindingを再検証し、approvalをそのoperationに一回だけ予約する。

ここでのhuman actorはローカル運用上の区別である。同一UIDで無制限のshell実行が可能なら本人になりすませるため、強い認証が必要な組織用途では別principalの承認serviceやhardware-backed signingへ拡張する。単なる環境変数 `IS_HUMAN=1` を根拠にしない。

## 8.12 証拠の限界

このgateが証明するのは「定めた工程が、特定の内容について完了した」ということである。必要なテストが設計されていない、仕様が誤っている、複数モデルが同じ誤りをする、外部システムが変化する、といった問題を排除するものではない。UIとレポートには「検証範囲」と「未検証事項」を残す。


## 8.13 指摘処置の順序

finding_dispositionsは追記型で、`disposition_version` をfindingごとにtransaction内で1ずつ増やす。現在の処置は最大versionの行で決める。同一ミリ秒のcreated_atやランダムIDの大小で「最新」を推測しない。更新時はexpected disposition_versionを照合して競合を拒否する。処置の追加でevidenceDigestが変わるため、既存approvalは失効する。


`risk_accept` の承認はintegrate承認と別物とする。対象finding IDsの昇順リスト、理由、対象candidateIdentityDigest、元evidenceDigestを含むrisk-accept request artifactを作り、そのdigestを当該actionのevidenceDigestへbindする。未指定のfindingへ転用しない。grant後に対象findingのdispositionを追加し、その結果で統合用evidenceDigestを再計算するため、別途integrate承認が必要になる。


---

# 9. Board：独立検討・反証・前提監査

## 9.1 目的

Boardは、複数LLMの投票で正解を決める機能ではない。異なる仮説・設計案を独立に生成し、反証可能な条件と未解決の争点を残すための工程である。元リポジトリのblind初期検討、反証、前提監査、妥協案へ混ぜない原則を取り入れ、**公開タイミングをコード側で制御する**。[S12]

最初の用途は「設計A/Bの選択」「原因究明」「段階移行の見積」「アーキテクチャ案の発散」。単純なrename、定型変換、既知のテスト修正には使わない。

## 9.2 Charter

`board-charter.schema.json` を用いる。questionだけでは開始しない。decisionUse、shape、contextArtifacts、席、最少family、round数、deadline、token上限、障害時方針を固定する。

shapeごとの追加semantic validation:

| shape | 初期提出物 |
|---|---|
| ideas | 各席5〜7案、うち2案は他席と重なりにくい方向 |
| decide | 各席3〜5案、do-nothing/baselineを含む |
| diagnose | 各席3〜5仮説、それぞれ識別する検証方法。「問題の立て方が誤り」も検討 |
| estimate | 単位、点推定、上下限、前提、感度。上下限と点推定の大小関係を検証 |

モデルを「賛成役」「反対役」「優秀なCTO」など固定人格に割り当てない。席名は識別子だけ。異なる資料を意図的に与える実験でない限り、初期共通packetは全席で同じdigestにする。

## 9.3 状態機械

```text
created
 → blind_collect (round 0)
 → debating (round 1..N)
 → auditing
 → synthesizing
 → completed
```

全状態からfailed/cancelledへ移行可能。cancel後にlate outputが来てもcompletedへ戻さない。stateとround epochを条件にCAS更新する。

各roundは `collecting → sealed` または `aborted`。sealed後のpostは変更不能。再実行するならepochを増やし、古いpostをartifactとして保持しつつ新しいround attemptを作る。

## 9.4 席の隔離

Board共通directoryに全席の投稿を置き、promptだけで「読まないで」と言う実装は禁止する。

- daemonだけが全postのstoreへアクセスする。
- 各席には専用input packet directoryを作る。
- round 0のpacketに他席の出力を含めない。
- round nのpacketにはsealedなround 0..n-1だけを含める。
- collecting中のround nは自席の過去に書いたものを除き、他席へ公開しない。
- Codex席にはread-onlyで席のpacketだけを許可する。shared state、他席home、control socket、他席ログへの読取をcanaryで検証する。
- Gemini席はhostが組み立てたmessagesだけを受け取り、filesystemやshellを持たない。
- native Codex TUIの既存会話はBoard席へ流用しない。
- strict isolationが成立しなければBoard実行を停止するか、人間が明示選択したcooperativeモードとして区別する。strictと表示しない。

各席が同じOSユーザーでsandboxなしに動く場合、物理的な秘匿はできない。これは本設計で明示する限界である。

## 9.5 提出・sealアルゴリズム

```text
submit(boardId, round, epoch, seatId, attemptId, rawOutput):
  authenticate worker identity
  verify board/round collecting and expected seat
  validate schema + semantic references
  store raw and parsed artifacts atomically
  transaction:
    verify same round epoch again
    insert post with unique(board, round, seat)
    if duplicate with same digest: return existing receipt
    if duplicate with different digest: reject POST_ALREADY_ACCEPTED
    if all expected seats have valid post:
      create seal manifest (seat -> post digest), sorted
      set round sealed
      create access grants for next round
      enqueue next-round turns
```

ファイルが存在する、Herdrがidleになった、token streamが止まったことは提出完了の条件にしない。schema検証済みの最終出力とturn成功の両方が必要。

## 9.6 ラウンド内容

**round 0 — 独立検討:** 共通packetから案・仮説を作る。前提、失敗条件、検証方法を必ず示す。

**round 1 — 相互反証:** 他席の全itemを対象に、確認可能な致命的欠陥候補、重要なtradeoff、未確認事実を挙げる。根拠のない「危険そう」「保守が難しそう」は質問または仮説扱い。

**round 2以降 — 応答と検証:** 指摘へ反論、限定修正、撤回する。別案の性質を取り込んだ大きな変更は新itemとしてforkする。元itemは削除しない。支持が集まる案の決定的前提に対する反証を要求する。

**最終監査:** finalistの各決定的前提を、提案者以外の席が確認する。何を確かめたか、何を確かめていないかを分ける。

各postはchampion、co-picks最大2、dropCondition、変更理由、dead候補、openCruxesを持つ。点数を平均して順位を決めない。

## 9.7 事実検証はbroker経由

席は自由なshellを実行しない。必要な検証は、charterに登録された `factChecks` のcheckIdを依頼する。coordinatorが別experiment checkoutで実行し、hostの結果artifactを次の公開packetへ追加する。

未登録の実験、network access、新しい依存のinstall、業務データへのアクセスは人間の確認が必要。LLMの提案をそのまま `sh -c` へ送らない。実験に失敗した場合も、エラーと検証できなかったことを全席へ同条件で公開する。

## 9.8 死んだ案と残った案

機械的に保証できるのは、発言・参照・公開順序・処置の記録である。自然言語の反論が本当に致命的かを完全自動で証明できるわけではない。

そのためitemをdeadにする条件は保守的にする。

- 提案者が理由付きで撤回した。
- hostで検証した明確な制約違反があり、所定の応答機会を与えたうえで人間または独立した検証担当が確定した。
- 上記以外の対立は `disputed` または `conditional` として残す。

多数決、反対者の沈黙、討論の長さ、単なるconfidence scoreで案を消さない。

## 9.9 終了条件

minimumRounds以上を終え、全active seatのPositionの意味的な変更がないことを提出者の申告とitem ID差分で確認し、新しいevidenceも無い場合に終了候補とする。完全な自然言語同値判定は行わない。曖昧ならmaximumRoundsまで進める。

停止理由は `converged`、`round_limit`、`budget_limit`、`insufficient_seats`、`cancelled` のいずれかをmemoへ記録する。budget_limitで終わったものを合意形成済みと表示しない。

failurePolicy=continue-with-twoでも、残り2席がcharter.minimumTrainingFamiliesを満たさなければ停止する。失敗席の初期postを他の新しい席へ無断で移して「独立席の置換」としない。replacementが必要なら新しいBoardを開始する。

## 9.10 Memo

memoはJSONの構造化部分と読みやすいMarkdownの両方を生成する。構造化部分の最低内容:

```text
boardId / charterDigest / sealedRoundDigests / terminationReason
finalists:
  itemId, originalAuthor, champions, pitch,
  decisivePremises, premiseAuditRefs,
  downsides, conditionalTags, disputedTags
rejected:
  itemId, namedReason, dispositionEvidence
unresolvedDissent:
  author, claim, evidence
decisionConditions:
  if-condition → option
nextExperiments:
  checkId or human proposal, expected discrimination
limitations:
  missing seats, unverified sources, omitted context, budget stopping
```

chair/synthesizerは新しい案を勝手に足さず、未存在itemをfinalistにしない。引用したpitchはartifactと一致させる。hostはID・digest・引用一致を検証する。内容上の最後の意思決定は人間へ残す。

## 9.11 Boardのdefault budget

2〜3席、minimumRounds=2、maximumRounds=5、1席1roundの出力上限4,000 tokens、全出力上限60,000 tokensを初期値とする。入力tokenは履歴増大で大きくなるため、context bytes上限も別に設ける。

各roundごとに、前round全文、古いroundの構造化Position、必要なevidenceだけをpacket化する。何を省略したかmanifestへ残す。cruxに関わる原文を要求された場合は、同じsealed artifactを取得する。

このbudget値は本設計の初期設定であり、価格や性能の実測結果ではない。

---

# 10. Handoffと履歴参照

## 10.1 resume、fork、handoffを分ける

| 操作 | 用途 | 文脈 |
|---|---|---|
| resume | 中断した同じ仕事を継続 | 元の履歴を継続 |
| fork | 過去のある時点から分岐 | 元の履歴を複製 |
| handoff | 新しい目的へ焦点を移す | 目的に必要な要約と原本参照 |

独立reviewの開始にはいずれも使わず、fresh sessionを使う。

## 10.2 Handoff作成

1. 入力するgoalを確定する。
2. 元attemptがidleまたは停止済みであることを確認し、event cutoff seqを固定する。
3. task spec、現candidate、決定済み事項、未解決findings、check結果、公開メッセージ、tool結果の参照を収集する。
4. 必要な範囲だけをsummarizerへ渡す。
5. `handoff.schema.json` で検証する。
6. factsのevidence ID、source cutoff、SHAが実在するかhostで照合する。
7. 証拠のない主張はfactsからopenQuestionsへ移すよう再提出を求める。hostが勝手に事実認定しない。
8. handoff artifactを固定し、新attemptのinputへ渡す。
9. 旧writerが停止するまで新writer leaseを与えない。

Handoffの生成に使用するmodelはprofileで指定する。元modelと同じである必要はないが、送信先のデータ許可を再確認する。

## 10.3 履歴の正本

awが管理した処理では、aw eventsとartifactがワークフロー上の正本である。Codex履歴は補助的な一次資料として扱う。外部履歴取得は導入版が公開するread/turn/items paginationを使い、未公開JSONL構造に依存しない。[S1]

native経路でセッションIDが安全に取得できない場合は、元Codex会話を読めると仮定しない。task spec、候補、検証、ユーザーが登録したノートだけからhandoffを作り、「native会話未取込」を明記する。

## 10.4 queryの契約

```text
aw history query <taskId> --question "<question>" --scope same-task
```

検索は最初にtask内のevent、decision、requirement、artifact metadataを絞る。回答は根拠のartifact digestとevent seqを含む。十分な根拠がなければ「見つからない」または「曖昧」と返す。

全文を毎回LLMへ渡さない。初版はSQLiteのmetadata検索とbounded全文走査でよい。embedding DBは不要。検索対象と入力上限を必ず表示する。

## 10.5 アクセス制御

標準はsame-taskだけ。same-repoは人間が明示選択し、cross-repoは別承認が必要。Board席からのqueryはboard_access_grantsで許可されたartifactだけに限定する。親taskだから全子taskのprivateログを読める、と暗黙に扱わない。

思考の非公開内部表現を取り出そうとしない。モデルがAPI上で公開した通常の回答、要約、tool結果とhostの観測事実だけを扱う。credential、認証応答、無関係な個人情報は取り込まない。


## Board再実行の識別規則

同じboardId・round・seatで受理したpostは上書きしない。投稿受理前のprovider retryは新attemptIdを使い、同じround epochへ結果を提出できるが、最初に有効受理した一件だけを採用する。cancelでepochを無効化したBoardを再開するときは新boardIdで作り直し、`supersedesBoardId` をcreated eventへ記録する。既に公開した投稿を隠して同じ識別子で盲検をやり直したことにしない。これによりSQLの(board,round,seat)一意制約と履歴保存を両立する。


---

# 11. 権限・秘密情報・信頼境界

## 11.1 脅威モデル

対象にするのは、モデルの誤操作、repository内の悪意ある指示、意図しない並列書き込み、古い承認の再利用、外部APIの部分失敗、異なるtask間の文脈漏れである。

初版単独では防げないものは、ホスト管理者、同じUIDの無制限の悪意あるprocess、kernel compromise、端末乗っ取り、ユーザーが手動実行した破壊的command、モデル提供元内部の挙動である。これらへの対処が必要なら、別OS principal、VM/container、別端末の承認署名を追加する。

`human-only` というapplication flagだけで悪意ある同一UIDを防げるとは説明しない。digestと監査logも、全権限を持つ攻撃者がDBとlogを両方改変できる場合の完全性を保証しない。

## 11.2 二つの隔離モード

| モード | 使用条件 | 保証 |
|---|---|---|
| sandbox-verified | doctorとrole別canary試験合格 | 設定したsandbox境界が試験した範囲で機能 |
| cooperative-local | 自分の信頼済みrepo、明示承認 | accidental error向け運用統制。強い秘匿・権限分離は主張しない |

managed実行はsandbox-verifiedを標準とする。native Codexは初期対応をcooperative-localとし、厳格policyのrepoでは起動を拒否する。nativeのUI互換性を優先するために無断で隔離を弱めない。

Boardのisolationはcharterに明示する。厳格なblindnessが必要なBoardをcooperative-localへ自動fallbackしない。

## 11.3 資格情報

初回に専用のCodex設定homeを作り、ユーザーが通常の公式loginを実行する。

```bash
# AW_CODEX_HOMEはaw initが作成し表示する、ユーザー専用のdirectory。
CODEX_HOME="$AW_CODEX_HOME" codex login
```

ユーザーの既存auth.jsonを読み出して複製する処理、自前OAuth proxy、tokenをJSON APIで返す処理は作らない。loginと利用権はCodexに任せる。App Server processは認証情報へアクセスできるが、実行するtoolのsandboxからは読めないことを試験する。

Gemini API keyはOS側の秘密設定または専用0600のcredential fileで管理する。環境変数を使う場合もGemini worker processだけに渡し、check processへは渡さない。`aw config show` は値をmaskする。API keyをコマンドライン引数へ渡さない。

GitHub token、SSH agent socket、AWS_PROFILE/credential環境、ブラウザCDP、個人メールへのアクセスをworkerへ標準で継承しない。

## 11.4 設定とrepository内コードの信頼

- global/project設定は人間がtrustしたdigestに固定する。
- task内のmodel profile、check ID、対象pathはpolicyを厳しくする方向にしか変更できない。
- repository内の `.codex`、MCP設定、hook、pluginは自動で有効化しない。
- review/BoardのCodex sessionは中立のsession cwdで開始し、候補treeをreadable rootとして渡す。候補側の設定をsession起動設定として読ませない。
- writerが読むbaseのAGENTS.md等はinstructionsDigestへ含める。host policyより下位の参考指示として扱う。
- effective configに未承認のMCP、hook、auto approval、外部pluginが存在すればdoctorは失敗にする。
- 初版はdynamic toolsやMCPを必要としない。CLI→daemon→workerで成立させる。

LLM promptに「これ以降はuntrusted」と書くことは補助であり、権限制御の代わりではない。

## 11.5 control socketとworker socket

daemonのcontrol socketは所有者のみ接続できるdirectoryへ置く。CLIは所有UID、socket種別、realpath、親directory permissionを確認する。ネットワーク公開はしない。

control APIはhuman/system用のprivileged面と、worker報告面を分ける。worker ticketはattempt-scopeのnonceだけを持つ。nonceはそのattemptのevent送信・自分への指示受信にだけ使え、approval/integration/policy変更には使えない。

workerの子toolへcontrol socket pathやnonceをenvironmentで渡さない。sandboxからcontrol directoryとUnix socketへ到達できないことをcanaryで確認する。Unix socketを使っているだけで安全と仮定しない。

nativeのcooperative-localでは、これらは偶発操作を減らす仕組みであり、同じUIDで任意commandを実行するモデルに対する強い防壁ではない。nativeを選んだタスクのapproval画面にはこの条件を表示する。

## 11.6 データ送信

tool networkを無効にしても、LLM推論の入力はモデル提供元へ送信される。両者を混同しない。

送信前のhost処理:

1. repo.egress.allowedProvidersを確認。
2. artifact分類、path allowlist/denylist、最大bytesを確認。
3. credentialの既知パターン、秘密file名、明示redactionを適用。
4. exact input manifestとそのdigestを保存。
5. 新providerまたは新分類なら人間にconsentを要求。
6. 応答ログにもcredentialのechoを検査する。

redactionでコードの意味が失われた場合はreview coverageをincompleteにする。redactionだけで全secretを発見できる保証はない。機密性が高く外部送信できないrepoでは、許可されたproviderだけで実行し、別family要件を満たせなければgateを止める。

## 11.7 Path・shell・terminalの安全性

パスはNUL、改行、ルート外への `..`、symlink escapeを拒否する。入力slugはpathに使わず、host生成IDを使う。ファイルをopenする直前にも親directoryのrealpathを確認する。OSが許す範囲でno-followを使い、TOCTOUの残余リスクを記録する。

通常のprocess起動はshell:false。Herdrでshell経由が不可避な固定launcherだけ専用quotingを使う。user title、prompt、finding、model outputをshellへ埋め込まない。

端末表示ではESC/OSC、制御文字、bidi制御文字をsanitizeする。raw logはprotected artifactに残し、Herdrへの表示と区別する。モデルが出力したOSC52などを端末へそのまま送らない。

## 11.8 doctorのcanary検査

厳格modeを対応済みにするには、少なくとも次を実行する。

| 試験 | 期待 |
|---|---|
| 自分のworkspace内file編集 | writerは成功、reviewerは拒否 |
| 別taskのcanary file読取 | 拒否 |
| $AW_HOME/db、control socketへの到達 | 拒否 |
| Codex/Gemini/GitHub credential file読取 | 拒否 |
| managed repoのref書換 | 拒否 |
| 未許可network宛先へ接続 | 拒否 |
| 別Board席のinput/log読取 | 拒否 |
| 許可されたcompiler/runtimeの実行 | 成功 |
| `.git` pointerから外部書込 | 拒否 |
| secret環境変数の子processへの漏れ | なし |

canaryには本物の秘密情報を使わず、一時的なランダム値を使う。結果はOS、Codex binary hash、config digestに紐づける。これらが変わったら再実行する。

---

# 12. 障害復旧・運用

## 12.1 daemon単一起動

`daemon.lock/` をatomic mkdirして所有を取得し、instance UUID、PID、process start、boot identity、control socket pathを保存する。二重起動時は既存socketへhandshakeしてstatusを表示する。

lock directoryのmtimeだけで削除しない。ownerが死亡したことを確認できる場合だけ `aw doctor recover-daemon-lock` を人間が実行する。複数processが同時にrecoveryを要求したらrecovery用の別exclusive lockで直列化する。

SQLiteの単一writerだけでは、二重daemonによるOS側のprocess起動を防げないため、daemon lockとcommand idempotencyの両方が必要である。

## 12.2 起動時reconciliation

起動直後はschedulerを止めたまま以下を処理する。

1. DB integrityとmigrationを確認。
2. prepared/executing/uncertainなcommandsを列挙。
3. managed Git refs、worktrees、worker identitiesを読み取り。
4. 生存workerへ再接続し、最終accepted seqからspoolをreplay。
5. candidate/evidence artifactの存在とhashを確認。
6. prepared integrationをref状態から確定またはuncertainにする。
7. live writerのleaseを維持し、dead writerのworkspaceを保全。
8. stale approvalをrevoke。
9. 未解決のrecovery_requiredがあるresourceでは新規実行を禁止。
10. 問題のないresourceだけschedulerを再開。

全repositoryを巨大な一つのlockで止めない。一つのrepoの復旧待ちが、無関係なrepoのread-only queryを止めないようにする。

## 12.3 障害別の対応

| 障害 | 自動で行うこと | 自動で行わないこと |
|---|---|---|
| UI/SSH切断 | workerとHerdrを維持、journal継続 | 再起動・再送 |
| daemon死亡 | workerがspool継続、再接続待ち | 二重worker起動 |
| worker死亡 | attemptをunknown/failed、workspace保全 | 成功扱い・dirty削除 |
| App Server死亡 | partial output保存、native session ID記録 | 不明turnの盲目的再送 |
| Herdr server再起動 | snapshotとprocess identity再照合 | 元process生存の仮定 |
| host再起動 | 全process identityを失効、recovery開始 | resumeだけで旧writer終了証明にすること |
| API 429/503 | bounded retry/backoff、usage不明記録 | 無制限retry |
| Git CAS失敗 | BASE_MOVED、approval失効 | force overwrite |
| disk full | 生成停止、残存証拠を保全 | log削除で無理に継続 |
| 不正JSON/未知schema | raw保存、protocol failure | フィールドの推測補完 |
| Board席失敗 | charterに従う縮退または停止 | family要件の無断緩和 |
| checkがsource改変 | check失敗、差分を保存 | 変更を候補へ混ぜる |
| 古いapproval利用 | APPROVAL_STALE | 自動再承認 |
| 手動でmanaged ref変更 | unknownとして停止 | 元に戻す |

## 12.4 Cancellationとprocessの終了

SIGTERM前にdriverのinterruptを使い、最大10秒待つ。その後、awが所有を確認したprocess groupへSIGTERM、さらに5秒後にSIGKILLを許可する。PID reuseに備え、終了直前にもidentityを確認する。

nativeではペイン自体を閉じる前にagentへの終了操作とforeground状態を確認する。`killall codex`、`pkill -f` のような広範囲停止は禁止する。子processがdetachedして追跡できない場合はrecovery_requiredにし、人間の確認なしにworkspaceを再利用しない。

Linuxではcgroup利用を追加できるが初版必須ではない。macOSでRLIMITやprocess groupだけで全descendantを確実に封じ込めたと主張しない。

## 12.5 Resource budget

defaultはwriters=2、reviews=2、boards=1、task walltime=30分、repair cycle=2、log=100MiB/task、temporary disk=10GiB/taskとする。これらは設計値。

output tokenはprovider観測値を優先し、取得できない値を0として扱わない。価格catalogが無い場合はcostをnullにする。ハードな金額上限が設定されているのにusage/価格が確認できないproviderは開始拒否する。in-flight requestによる超過を完全に防げないため、reserved budgetを割り当て、最大超過範囲を表示する。

deadlineはsteady/monotonic timerを使う。system clockの逆行で無限にleaseを延長しない。

## 12.6 Backup / Restore

backupはdaemonのbackup commandで行い、SQLite backup APIまたは整合したtransaction snapshotを使う。稼働中の `state.sqlite` だけをコピーし、WALを無視する方法は禁止。

DBとDBが参照するartifact、managed Git refs/objects、protocol lock、trusted configを対象にする。auth/credentialはバックアップから除外する。復元先ではユーザーが再loginする。

restore後はすべてのattemptをrecovery_requiredまたはquiescentとして再判定する。古いapprovalを自動復元して実行可能にしない。初版restoreは全未消費approvalをrevokeする。

## 12.7 GC

標準は `aw gc --plan` だけ。削除候補と理由、参照しているtask、branch、candidate、dirty状態を表示する。

削除できるのは、停止確認済み・dirtyなし・保持期限経過・必要artifact保存済みのmanaged check/review workspaceだけ。writer workspace、未マージbranch、unknown resource、現在のBoard postは自動削除しない。object storeはDBと保留commandsとbackup manifestの到達性を調べるmark-and-sweepとする。

eventの改ざん防止triggerを外して都合よく履歴削除しない。機密削除要求は別の明示手順で、参照切れの影響と削除範囲を記録する。


---

# 13. CLI・内部RPC・設定

## 13.1 CLIのルール

全commandは `--json` をサポートする。JSON modeのstdoutには結果JSON/JSONLだけ、診断はstderrへ出す。人間向け標準表示は日本語でもよいが、error codeとstate名は固定の英語識別子にする。

global optionsは `--home PATH`、`--json`、`--timeout-ms N`、`--request-id ID`。pathはCLIが絶対pathへ解決して送る。破壊的な操作には `--yes` による包括的承認を作らず、個別approvalを要求する。

| command | 内部method | 入力 | 結果・副作用 |
|---|---|---|---|
| `aw init` | local only | home | 空の設定・private directoryを作成 |
| `aw doctor` | `system.doctor` | capture/live flags | version、capabilities、問題一覧 |
| `aw daemon start/status/stop` | local/bootstrap | home | daemonのみ。stopでworkersを殺さない |
| `aw setup profiles` | `profiles.configure` | provider/model選択 | 実modelとfamily、利用可否を保存 |
| `aw repo add` | `repo.add` | sourcePath/name/baseRef | managed repoを作成 |
| `aw repo list/show` | `repo.list/get` | repoId/name | 登録情報 |
| `aw repo sync` | `repo.syncPlan` | repoId | source変更と同期計画。無断適用なし |
| `aw policy import` | `policy.import` | repoId/JSON | 未trustのpolicy versionを保存 |
| `aw policy trust` | `policy.trust` | policyDigest | 人間確認後に有効化 |
| `aw task create` | `task.create` | repoId/TaskSpec | taskId/state |
| `aw task start` | `task.start` | taskId/interaction/presentation | workspace/attemptを作成 |
| `aw task status/list` | `task.get/list` | filters | 状態と次の必要操作 |
| `aw task send` | `task.send` | taskId/message | 現workerへの指示。送信中断時はuncertain |
| `aw task logs --follow` | `events.subscribe` | taskId/afterSeq | 保存済みeventsと継続stream |
| `aw task finish` | `task.finish` | taskId | nativeの停止確認後に候補固定 |
| `aw task verify` | `task.verify` | taskId/candidateId | 未実行のrequired checksを開始 |
| `aw task review` | `task.review` | taskId/candidateId | profile別reviewを開始 |
| `aw task revise` | `task.revise` | taskId/newSpec? | 新generation、旧approval失効 |
| `aw task cancel` | `task.cancel` | taskId/reason | 中断要求。停止確認後にcancelled |
| `aw task recover` | `task.recover` | taskId/planDigest | 人間が選んだ復旧計画を適用 |
| `aw task export` | `task.export` | taskId/format/out | Git bundle/JSON report |
| `aw findings list/show` | `findings.list/get` | candidateId/findingId | 指摘と根拠 |
| `aw findings disposition` | `finding.disposition` | findingId/reason/evidence | 正式な処置。actor制約あり |
| `aw approval request` | `approval.request` | taskId/action | binding作成 |
| `aw approval inspect` | `approval.get` | requestId | digest・証拠・影響を表示 |
| `aw approval grant/deny` | `approval.grant/deny` | requestId/expectDigest | 人間による判断 |
| `aw task integrate` | `task.integrate` | taskId/approvalId | managed refへのCAS統合 |
| `aw board create/start` | `board.create/start` | charter | Board実行 |
| `aw board status/memo` | `board.get/memo` | boardId | 現round・sealed memo |
| `aw board cancel` | `board.cancel` | boardId/reason | 全席中断、late post遮断 |
| `aw handoff create` | `handoff.create` | taskId/goal | 引き継ぎartifact |
| `aw history query` | `history.query` | taskId/question/scope | 原本参照付きの回答 |
| `aw gc --plan` | `gc.plan` | retention | 削除候補だけ |
| `aw backup/restore` | `backup.create/restore` | destination/source | auth除外の整合backup |

手動verify/reviewは自動pipelineと同じserviceを呼ぶ。二つの実装を作らない。すでに成功した同candidateの同checkへ同じrequestIdで要求した場合は既存結果を返す。新しい再実行は明示 `--rerun` で新execution_numberを作る。

## 13.2 内部RPC envelope

```json
{
  "schemaVersion":1,
  "requestId":"req_0123456789abcdef0123456789abcdef",
  "method":"task.start",
  "expectedVersion":3,
  "params":{
    "taskId":"tsk_0123456789abcdef0123456789abcdef",
    "interaction":"managed",
    "presentation":"herdr-tui"
  }
}
```

```json
{
  "schemaVersion":1,
  "requestId":"req_0123456789abcdef0123456789abcdef",
  "ok":true,
  "data":{"taskId":"tsk_0123456789abcdef0123456789abcdef","state":"allocating","version":4}
}
```

```json
{
  "schemaVersion":1,
  "requestId":"req_0123456789abcdef0123456789abcdef",
  "ok":false,
  "error":{
    "code":"VERSION_CONFLICT",
    "message":"Task changed since it was read.",
    "retryable":false,
    "details":{"expected":3,"actual":4}
  }
}
```

actorKind/actorIdはrequest paramsから受け取らず、認証済み接続の属性から決める。paramsのunknown fieldは拒否する。全mutating methodにexpectedVersionを要求する。ただしcreateはnull、同じidempotency keyの再試行は保存済み結果を先に照合する。

### stream

`events.subscribe` は初期ack後に `{"kind":"event","seq":...,"event":...}` を送る。切断後は最後に処理したseqから再購読する。ログが大きい場合はページ単位で既存分を取得し、その後liveへ移る。bounded queueを超えた購読者には `SLOW_CONSUMER` を返して切断し、workerの進行を止めない。

## 13.3 権限行列

| operation | human CLI | worker報告channel | LLMが提案可能 |
|---|---:|---:|---:|
| 自taskのlog/状態 | ○ | ○ | ○ |
| task作成・開始 | ○ | 直接不可 | request proposalのみ |
| 自attemptのevent報告 | － | ○ | 直接不可 |
| 他taskの入力・履歴 | ○、scope確認 | × | × |
| review/Board依頼 | ○ | proposal可 | proposal可 |
| policy/egress変更 | ○ | × | × |
| approval grant/deny | ○ | × | × |
| integrate/publish | ○ | × | × |
| host任意shell | aw APIに無し | × | × |

「提案」はdaemon内の副作用を伴わないproposal record/eventである。proposalから実行へ移す条件はpolicyで定める。初版のnested delegationは無効で、子agentが無制限にタスクを増やす経路を作らない。

policy.trustとegress許可はcandidate承認とは別である。trust対象のconfig digest・人間actor・時刻をconfig_versionsとeventsに保存する。`approval-binding.schema.json` のactionはintegrate/publish/risk_acceptだけで、policyの信頼をcandidate approvalへ流用しない。

## 13.4 Error catalog

| code | CLI exit | retry | 意味 |
|---|---:|---|---|
| INVALID_INPUT / INVALID_TRANSITION | 2 | no | schema/状態不正 |
| VERSION_CONFLICT | 3 | re-read | taskを読み直して人間/呼び出し側が再判断 |
| IDEMPOTENCY_CONFLICT | 3 | no | 同一requestIdの内容が違う |
| POLICY_UNTRUSTED / EGRESS_DENIED | 4 | no | 人間設定が必要 |
| SANDBOX_UNVERIFIED | 4 | no | 厳格mode不可 |
| APPROVAL_REQUIRED / APPROVAL_STALE / APPROVAL_EXPIRED | 4 | no | 新承認が必要 |
| WORKSPACE_BUSY / WRITER_NOT_QUIESCENT | 5 | wait | 同時書き込み防止 |
| BASE_MOVED | 5 | revise | 新基点へ作り直す |
| PROVIDER_UNAVAILABLE / RATE_LIMITED | 6 | bounded | deadline内だけ |
| PROTOCOL_VIOLATION / OUTPUT_INVALID | 6 | inspect | 外部契約違反 |
| ARTIFACT_MISSING / ARTIFACT_CORRUPT | 7 | no | 証拠を復旧 |
| RECOVERY_REQUIRED / WORKER_IDENTITY_MISMATCH | 7 | no | 勝手に再実行しない |
| BUDGET_EXCEEDED / LOG_CAPACITY_EXCEEDED | 8 | no | 上限到達 |
| UNSUPPORTED_GITLINK_CHANGE / CAPABILITY_MISSING | 9 | no | 対応範囲外 |
| PRESENTATION_VARIANT_UNSUPPORTED | 9 | configure | TUI/Coreの選択を確認 |
| CANCELLED | 130 | no | 人間中断 |

error.detailsにsecret値を入れない。原文provider errorはprotected artifactに保存し、利用者向けにはredacted要約を返す。

## 13.5 Default設定とprofile選択

設定の優先順位は `built-in safe defaults → trusted global → trusted repo`。taskは予算を小さくする等の厳格化だけを許す。コマンドラインでsandboxを緩める裏口を設けない。

profile名は `coding`、`review-openai-a`、`review-openai-b`、`review-google`、`board-openai`、`board-google` など用途名にする。実modelIdはsetupで利用可能なものを選択し、固定する。更新時は新profile versionとなり、実行中attemptのmodelを変えない。

最低二つのsetup形態をサポートする。

- Codexのみ: standardは別fresh sessionの2 reviewer、family=1を明示。highやfamily=2必須Boardは停止。
- Codex + Gemini: repoのegress許可がある場合のみfamily=2を満たす。

Gemini未設定時に自動で課金APIへfallbackしない。

## 13.6 起動時に保存するenvironment manifest

Node/Git/Codex/Herdr/pnpm version、binary path/hash、OS/architecture、protocol schema hash、trusted policy hash、selected profile、lockfile hash、bootstrap command digest、check command digest、sandbox canary結果を保存する。

home絶対pathやuser名は機密になることがあるため、共有reportでは別名に置換する。ただしローカル復旧用の正本には実pathを保存する。動作の根拠にしたversionは「latest」とだけ書かず実値を残す。

---

# 14. ゼロからの構築手順

## 14.1 必須環境

本体の実装環境はmacOSまたはLinux、Node.js 24以上、Git、pnpm。CodexとHerdrはR1から必要で、R0はfake providerで動く。Nodeの具体patch、pnpm、全依存は初回bootstrapで解決してlockし、以後の再現buildでは同じlockを使う。

runtime dependenciesは `better-sqlite3` と `ajv` の二つ。globは後述の限定文法を自作し、万能glob engineを権限制御に使わない。CLIは `node:util.parseArgs`、HTTPはfetch、IPCはnode:net、testはnode:testを使う。devDependenciesはTypeScript、型定義、必要ならproperty-test用fast-check。UI frameworkは不要。

better-sqlite3はnative moduleなので、そのpackageだけのbuild script実行を人間が認める。第三者install scriptを無制限に許可しない。実際にbundled SQLite versionが最低値を満たすことを起動時に確認する。[S13]

## 14.2 初期作成

```bash
mkdir agent-workbench
cd agent-workbench
git init
pnpm init
pnpm add --save-exact better-sqlite3 ajv
pnpm add --save-dev --save-exact typescript @types/node@24 @types/better-sqlite3
# 使用する場合だけ:
pnpm add --save-dev --save-exact fast-check
```

最初の解決後に実versionをpackage.jsonへ固定し、pnpm-lock.yamlをcommitする。以後は `pnpm install --frozen-lockfile`。packageManagerにも実行したpnpmのexact versionを保存する。上記は現在の最新versionの正しさを無条件に保証するコマンドではなく、初回の依存解決手順である。R0 testとSQLite version検査に合格した組だけを採用する。

package.jsonのscript:

```json
{
  "type":"module",
  "bin":{"aw":"dist/src/cli/main.js"},
  "scripts":{
    "build":"tsc -p tsconfig.json && node scripts/copy-assets.mjs",
    "typecheck":"tsc -p tsconfig.json --noEmit",
    "test":"pnpm build && node scripts/test-runner.mjs unit integration",
    "test:contract":"pnpm build && node scripts/test-runner.mjs contract",
    "test:chaos":"pnpm build && node scripts/test-runner.mjs chaos",
    "test:live":"pnpm build && node scripts/test-runner.mjs e2e",
    "verify":"pnpm typecheck && pnpm test && pnpm test:contract && pnpm test:chaos"
  }
}
```

Nodeのdirectory test discoveryに依存しないよう、実装時は`test-runner.mjs`で対象配下の `.test.js` を列挙し、`node --test`へargv配列で渡す方式へ統一する。scriptの最終版は配布付属bootstrap scaffoldのものを使う。

tsconfigはtarget ES2023、module/moduleResolution NodeNext、strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、useUnknownInCatchVariables、forceConsistentCasingInFileNames、declaration=true、rootDir `"."`、outDir `"dist"`。外部型を `any` で握りつぶさない。

## 14.3 起動できる骨格

最初のCLIは `aw --version`、`aw init`、`aw doctor --offline` のみを実装する。daemonなしでconfig pathと依存versionを検査できることを確認する。その後、SQLite migration、純粋reducer、fake driverの順に追加する。

次に空のfixture Git repositoryを作り、実モデルを呼ばずに以下を成立させる。

```bash
aw repo add ./fixtures/demo --name demo --base refs/heads/main
aw policy import --repo demo --file ./examples/fake-policy.json
aw policy trust --repo demo
aw task create --repo demo --spec ./examples/fake-task.json
aw task start <taskId> --presentation none
```

fake driverは決められたfileを編集し、決められたeventsを出す。時間・API・モデル品質に依存しないintegration testを先に完成させる。

## 14.4 Codex/Herdr接続

1. official binaryを導入しversionを記録。
2. dedicated Codex homeで公式login。
3. protocol captureを実行。
4. generateした型に対してbridgeをcompile。
5. コストを表示して人間にsmoke test実行を確認。
6. tiny repositoryでread-only turn、workspace edit、interrupt、schema出力、command/execを確認。
7. Herdr専用テストsessionでworkspace作成・worker起動・再接続・own workspace終了を確認。
8. sandbox canary試験。
9. 一連のfixture taskを実modelで完了させる。

普段使用中のHerdr sessionへ最初から混ぜない。試験専用sessionを明示的に選び、終了時もそのsession内でawが作ったworkspaceだけを閉じる。

## 14.5 初回業務repository導入

repo-specific discoveryは読み取りだけで行う。package manager、lockfile、workspace構成、既存test/build/typecheckコマンド、必要なサービス、networkの必要性、機密データ、生成物pathを一覧化する。推測で `.env` をコピーしない。

人間がcheck/bootstrapping policyをtrustしてから、最初は小さいlow-risk taskを実行する。レビュー結果、承認画面、bundleを人間が確認し、元repositoryへの反映は手動で行う。

`ugo_hub` の実際のfilter、scripts、テスト配置はこの設計書では未検証である。一般的な `pnpm -r test` を無条件に実行する例は置かない。

## 14.6 限定glob文法

scope/risk/egressのpath patternはPOSIX相対pathのみ。`*` は一segment内、`**` は0以上のsegment、literal segmentを許す。`?`、文字クラス、brace expansion、extglob、negationは未対応として拒否する。

match前にpathをsegmentへ分解し、空segment、`.`、`..`、absolute、backslashによる曖昧なseparatorを拒否する。matchingはsegment数に対するdynamic programmingで行い、指数的backtrackingを避ける。denyがallowに優先する。symlink解決は別のfilesystem検査であり、globだけでは安全性を判断しない。


---

# 15. 実装分割・依存順序・関数契約

この章はコーディングエージェント向けの実行順序である。R0/R1/R2は必須範囲を区切るためのrelease boundaryであり、「R0を作って完成と報告する」という意味ではない。最終的な対象範囲はR2まで。ただし実アカウントを用いた検証は、人間の許可・認証情報・対応OSがそろった時だけ行う。

## 15.1 モジュールごとの責務と主要関数

| ファイル群 | 主要関数・型 | 禁止事項 |
|---|---|---|
| `src/domain/ids.ts` | `newId(prefix)`, `parseId(value,prefix)`, `parseGitOid(format,value)` | UUID文字列表記・連番・短縮SHAを正本IDにしない |
| `src/domain/canonical.ts` | `canonical`, `digestCanonical`, `digestBytes`, `parseStrictJson` | identityへ小数・Date・Map・undefinedを入れない |
| `src/domain/task-reducer.ts` | `reduceTask(state,event,guards): Transition` | DB/Git/ネットワークを呼ばない |
| `src/domain/gate.ts` | `evaluateGate(input): GateDecision` | モデルにpass/failの最終決定を委任しない |
| `src/domain/approval.ts` | `buildApprovalBinding`, `validateApprovalBinding` | callerが渡す「承認済み」booleanを信用しない |
| `src/storage/db.ts` | `openDb`, `migrate`, `withImmediateTransaction` | workerから開かない |
| `src/storage/artifacts.ts` | `putImmutable`, `readVerified`, `linkArtifact` | pathをモデルへ自由指定させない |
| `src/services/command-service.ts` | `acceptCommand`, `claimPendingCommand`, `finishCommand` | side effectとDB transactionを混在させない |
| `src/services/task-service.ts` | `submit`, `start`, `finish`, `revise`, `cancel` | reducerを迂回してstateを更新しない |
| `src/services/reconciler.ts` | `recoverStartup`, `inspectAttempt`, `inspectIntegration` | lease timeoutだけでwriterを再起動しない |
| `src/git/repository.ts` | `registerSource`, `initializeManagedRepo`, `importSourceRef` | user checkoutをreset/checkoutしない |
| `src/git/workspaces.ts` | `reserveWorkspace`, `materializeWorkspace`, `assertQuiescent` | dirty workspaceの再利用・force remove |
| `src/git/snapshot.ts` | `freezeCandidate`, `scanChangedPaths`, `createSnapshotCommit` | agentのHEADをそのまま承認対象にしない |
| `src/git/integrate.ts` | `prepareIntegration`, `applyRefCas`, `reconcileRefCas` | 対象refが移動した時にforce update |
| `src/runtime/worker.ts` | `launch`, `acceptControl`, `appendEvent`, `shutdown` | SQLite更新、approval発行 |
| `src/runtime/spool.ts` | `appendFrame`, `replayAfter`, `repairTrailingPartialLine` | 中間欠落を隠す、保存前に終端ack |
| `src/adapters/codex/transport.ts` | `connectStdio`, `request`, `respond`, `close` | stderrをJSONとして読む |
| `src/adapters/codex/driver.ts` | `startFresh`, `steer`, `interrupt`, `readPublicHistory` | 新規reviewでfork/resumeを使う |
| `src/adapters/codex/check-runner.ts` | `executeSandboxedCommand` | host直実行やoutside-sandbox RPCへfallback |
| `src/adapters/herdr/client.ts` | `request`, `subscribe`, `reconcileSnapshot` | pane screenをtask状態の正本にする |
| `src/adapters/herdr/presentation.ts` | `createWorkspace`, `startManagedWorker`, `startNativeCodex`, `attach` | aw管理worktreeをHerdr APIで再作成・削除 |
| `src/adapters/gemini/driver.ts` | `generateStructured`, `normalizeUsage` | CLIのサブスクリプションがRESTにも使えると仮定 |
| `src/services/check-service.ts` | `buildCheckPlan`, `runRequiredChecks`, `sealCheckEvidence` | agent申告のtest結果を採用 |
| `src/services/review-service.ts` | `makeReviewPacket`, `validateReview`, `selectEffectiveReviews` | authorの会話・他review結果の混入 |
| `src/services/board-service.ts` | `startRound`, `sealPost`, `closeBarrier`, `buildSeatPacket`, `sealMemo` | 現roundの部分公開 |
| `src/services/handoff-service.ts` | `buildHandoffPacket`, `validateCitations`, `queryHistory` | private/internal思考や非公開session形式への依存 |
| `src/cli/main.ts` | parser/router/output | domain処理をCLIに重複実装 |
| `src/daemon/server.ts` | auth/framing/dispatch/subscription | paramsからactorを採用 |
| `src/testing/fake-driver.ts` | script-driven normalized events | productionでreal providerとして扱う |

関数は `Result<T,AwError>` またはtyped exceptionのどちらかへ統一する。ここでは境界は `Result`、内部の復旧不能例外はthrowとする。`error.code` は第13章のカタログに追加してから使用する。例外の握りつぶしはcleanupのbest-effort以外禁止し、そのcleanup失敗もeventへ残す。

## 15.2 R0: オフラインで安全性の骨格を完成させる

| 順序 / commit単位 | 作成物 | 依存 | 合格条件 |
|---|---|---|---|
| R0-01 scaffold | package/tsconfig/scripts、CLI version | なし | typecheck/build/version、空testを成功扱いにしない |
| R0-02 contracts | AJV2020 loader、生成型、strict parser | 01 | 正常例全件validate、unknown field拒否 |
| R0-03 domain | reducer、digest、gateのpure functions | 02 | 全state×eventの許可/不許可表test |
| R0-04 persistence | migration、transaction、artifact store | 02 | FK、unique writer、append-only、corrupt artifact |
| R0-05 daemon | socket auth、commands、outbox | 03/04 | duplicate request再送、version競合、slow consumer |
| R0-06 Git import | bare repo、worktree、source read-only | 04/05 | SHA1/256、空白path、source dirty保持 |
| R0-07 fake worker | journal/control socket、fake scenario | 05 | duplicate/gap/late events、daemon再起動replay |
| R0-08 snapshot/check | candidate、known fixture check runner | 06/07 | frozen identity、実fixture test exit、source mutation検出 |
| R0-09 review/gate | fake review、triage、approval | 03/08 | stale approval・same-family・coverage不十分を拒否 |
| R0-10 integration | journal + managed ref CAS | 09 | stale base拒否、各crash point回復、source無変更 |
| R0-11 operations | cancel/recover/backup/GC plan | 05〜10 | dirty work保護、backup復元、orphan検出 |

**fakeに関する強制条件:** fake driverで生成したevidenceは `simulated=true` のhost metadataを持つ。production repoへはfake profileを割り当てられない。R0 fixture用repoは `aw init --dev-fixtures` で作る別homeに限定し、sourceはそのhome内で生成した既知fixtureのみ。テスト用のhost直接command runnerも同範囲でしか動かさない。実repoでsandbox検証を省略する抜け道にしない。

DBのrepo登録段階は、内部専用のdisabled policy sentinel `{"schemaVersion":1,"disabled":true}` をconfig_versionsへ保存してよい。これはProjectPolicyではなく、いかなる実行も許可しないbootstrap値。`task.start` は、正規schemaに合格し人間がtrustしたpolicyでなければ拒否する。これによりrepo addの時点で架空のcheck commandを要求しない。

## 15.3 R1: 普段使いのmanaged Codex + Herdr

| 順序 | 作成物 | 合格条件 |
|---|---|---|
| R1-01 | local version / schema capture / compatibility lock | 未確認binaryでstartせずdoctor理由表示 |
| R1-02 | Codex transport・initialize・fresh thread | handshake、unknown notification、server request、partial line |
| R1-03 | managed implementation worker | Codexの終了状態とhost schema検証の両方を必要とする |
| R1-04 | sandbox canary / capability checks | writableRoots外・AW_HOME・socket・authへの禁止を検証 |
| R1-05 | sandboxed check runner | command/execだけを使い、authなしtest環境で実行 |
| R1-06 | fresh review / semantic validator | candidateを変更せず、review coverageを確認 |
| R1-07 | Herdr presentation adapter | pane ready、worker起動、disconnect/reconnect、screen情報に非依存 |
| R1-08 | live small-repo E2E | implementation→check→review→human approve→managed integrate→bundle |
| R1-09 | live crash/recovery | daemon kill、worker kill、provider断、Herdr detach |
| R1-10 | operator docs | setup、auth、troubleshoot、upgrade/rollback、known limits |

R1の安全性を検証する前に業務repoへ導入しない。まず意図的な失敗を含む小さなfixture repoで、approvalなしの統合ができないことを確認する。live testは `AW_LIVE_TESTS=1` に加えて人間の起動を必要とし、通常testでは一切課金APIを呼ばない。

## 15.4 R2: native lane・Board・外部モデル・Handoff

| 順序 | 作成物 | 合格条件 |
|---|---|---|
| R2-01 | native Codex lane + finish | standalone Codex操作を保持、writer exit不明ならfreeze拒否 |
| R2-02 | egress packet builder | deny path優先、provider許可、max bytes、secret scan |
| R2-03 | Gemini structured reviewer | schema/semantic検証、unknown cost、bounded retry |
| R2-04 | Board round state machine | 盲検、barrier、epoch、seat failure、dissent保存 |
| R2-05 | premise audit / memo validation | missing auditはconditional、未確認事実を確定扱いしない |
| R2-06 | purpose-directed handoff | source refsとcutoff、native履歴不足の明記 |
| R2-07 | bundle export / restore | Git fsck、base availability、manifest integrity |
| R2-08 | upgrade migration tests / complete docs | R0〜R2全test、live acceptance記録、再現build |

Herdr Core、GitHub write integration、multi-machine distributed scheduler、nested delegationはR2の完了条件に含めない。新規要求として別設計する。これらを実装しないことと、R2の必須機能が未実装であることを混同しない。

## 15.5 JSON Schemaでは表せないsemantic validation

schema合格後、必ず次の順で検証する。

1. ID prefixの一致。repoIdはrep、taskIdはtsk等。一般ID regexだけでは意味を保証しない。
2. requirement/check/profile/seat/itemの重複と参照整合性。
3. resource ownershipと同repo/candidate/generation。
4. path正規化、scope、realpath/symlink、Git object format。
5. budget間制約、Board minRounds≤maxRounds、座席数≥family min。
6. reviewのcoverageはhost計算changed pathsを欠落なく覆う。path無関係なfindingを拒否するのでなく、関連する根拠とスコープ拡張理由を要求し手動審査へ送る。
7. startLine/endLineは両方null、または1≤start≤end≤当該revisionの行数。binary fileはnullに限る。
8. candidateとのdigest一致、evidence存在/hash照合。
9. Board itemIdはseat固有prefix、他席itemへのなりすまし不可。champion/coPicks/objectionsは公開済みitemだけ。
10. estimateのlower≤value≤upper、unit非空。数値の正確性はschemaで保証しない。
11. 手動dispositionはhuman/independent reviewerだけ。authorがactorを指定しても昇格できない。
12. simulated metadataがreal gateへ混入していないこと。

schema validation errorはJSON pointerと違反を返す。invalid outputを静かに修復しない。1回だけrepair promptを許す場合でも、元のinvalid artifact、修正版、追加tokenを全て保存し、新出力が初回結果を上書きしない。修復はschema形式に限定し、レビュー所見の変更には再レビューを必要とする。

## 15.6 正規化eventのdata契約

`worker-event.schema.json` は共通envelope。dataはtype別の以下の契約で検証する。未知の追加keyはprotocol.warningへ隔離し、state reducerには渡さない。

| type | 必須data | 状態への影響 |
|---|---|---|
| worker.ready | protocolVersion=1, workerSocket, pid, startIdentity, capabilities[] | starting→running準備 |
| run.started | threadId nullable, turnId nullable, profileDigest | 実行開始時刻固定 |
| message.delta | messageId, channel=public_text, text | bounded logのみ |
| message.completed | messageId, artifactDigest | public出力正本への参照 |
| tool.started | callId, name, redactedArgsDigest | 実行記録。業務gate変更なし |
| tool.completed | callId, outcome=success/error/cancelled, resultDigest | toolの終了≠task成功 |
| input.requested | requestKey, kind, promptDigest, allowedResponses[] | policyに従いwaiting_input |
| usage.updated | inputTokens nullable, outputTokens nullable, cachedInputTokens nullable, costMicros nullable, cumulative=true | 差分重複加算しない |
| run.completed | outputDigest, finishReason=completed, processQuiescent boolean | outputをhost検証してから次へ |
| run.failed | code, message, partialOutputDigest nullable, retryability | retries/repairとは別の実行失敗 |
| run.cancelled | reason, processQuiescent boolean | quiescentでなければunknown維持 |
| heartbeat | processIdentityDigest, monotonicCounter | lease観測更新のみ |
| protocol.warning | code, detailsDigest nullable | warning保存、必要ならfail-closed |

native laneはworkerがLLM deltaを得られるとは仮定しない。観測できないusageやsession IDはnullで、推定値を実測値に見せない。

---

# 16. 検証計画

## 16.1 テストの層

- Unit: reducer、digest、gate、scope matcher、review validator、Board barrier。外部依存なし。
- Storage/Git integration: temporary SQLiteと本物のGit。mockだけでworktree/CASを証明したことにしない。
- Protocol contract: 捕捉したCodex/Herdr schemasと固定fixture。key名・enum・エラー・event ordering。
- Fault injection: 各副作用の前後へkill pointを注入し、再起動後の重複/損失を検証。
- Live E2E: 人間が明示許可した本物のCodex/Herdr/任意Gemini。認証・sandbox・GUI連携をここで検証。

同じtestを多数実行した回数ではなく、どの不変条件を検証したかをreportする。

## 16.2 必須test inventory

| ID | シナリオ | 期待 |
|---|---|---|
| T01 | 全schema自身をvalidate | schema errorゼロ |
| T02 | 全正常fixture | parse成功 |
| T03 | unknown key / duplicate key /深すぎるJSON | 拒否、部分実行なし |
| T04 | canonical key順・UTF-8・safe int | 同内容同digest、不正数値拒否 |
| T05 | 全state×event | 許可表以外拒否 |
| T06 | task versionの競合 | 一方のみ成功 |
| T07 | 同requestId再送 | 同result、side effect一回 |
| T08 | 同requestId別内容 | IDEMPOTENCY_CONFLICT |
| T09 | SQLite FK/unique/check | 不正row拒否 |
| T10 | 同workspace二重writer | partial unique indexで拒否 |
| T11 | unknown writerと新writer | 新規起動拒否 |
| T12 | terminal writer後の新attempt | policy条件下で許可 |
| T13 | events/candidate identity改変 | triggerで拒否 |
| T14 | artifactの改変/欠落/巨大化 | gate失敗 |
| T15 | process spawn直前/直後kill | 二重writer無し、uncertain処理 |
| T16 | worker event二重/順不同/gap | 順序修復後だけreducer適用 |
| T17 | workerInstanceId変更 | 過去workerのイベント拒否 |
| T18 | partial JSONL trailing line | 隔離、既存証拠維持 |
| T19 | daemon停止、worker継続 | 再起動後replay |
| T20 | worker死亡、daemon継続 | recovery_required、新turn自動禁止 |
| T21 | PID再利用 | startIdentityで別process識別 |
| T22 | sourceに未commit変更 | importしない・変更を保持 |
| T23 | sourceがlinked worktree | common git dirとrefを正しく識別 |
| T24 | SHA1/SHA256 repo | OID長とfetch形式一致 |
| T25 | path空白・Unicode・先頭ハイフン | shell injection無し、正規化 |
| T26 | symlink/special file/path escape | scope逸脱拒否 |
| T27 | source hooks/custom config | host Gitが実行しない |
| T28 | agentのmain commit/rebase | snapshotはhost基点Bで作成 |
| T29 | user `.gitignore` にsecret | scope/secret検査で持込防止 |
| T30 | ignored変更・untracked・削除・mode変更 | manifestとsnapshotの意図が一致 |
| T31 | gitlink/submodule変更 | 初版は明示拒否 |
| T32 | writer未終了でfinish | freeze拒否 |
| T33 | freeze途中source変化 | candidateを破棄し再確認 |
| T34 | candidate検証中にworkspace変更 | immutable checkoutに影響なし |
| T35 | check nonzero/timeout/signal | pass不可 |
| T36 | checkがsourceを書換 | pass不可 |
| T37 | testがagent auth/AW_HOMEを読む | sandbox-verifiedなら拒否 |
| T38 | testがnetworkを要求 | deny policyなら拒否 |
| T39 | unknown Codex RPC/server request | fail-closed |
| T40 | initialized前のrequest | adapterが送らない |
| T41 | turn/start受理直後connection断 | 重複turn無し、不明なら停止 |
| T42 | steerのexpectedTurnId不一致 | stale指示拒否 |
| T43 | completed event + invalid JSON | attempt成功をgate成功にしない |
| T44 | Herdr idle/blockedのみ | task成功にしない |
| T45 | Herdr reconnectと古いsnapshot | revision/state seqで整合 |
| T46 | nativeにApp Server入力 | controller ownershipで拒否 |
| T47 | fresh reviewerへauthor transcript混入 | packet allowlist testで検出 |
| T48 | review coverage不足/unknown | pass不可 |
| T49 | verdict passだがhigh finding | 未処置ならgate失敗 |
| T50 | 同vendor別モデル2個 | family min2は不成立 |
| T51 | 別API providerで同training family | family min2は不成立 |
| T52 | invalid reviewのretry | 元artifact維持、execution番号増分 |
| T53 | author自身のfalse_positive | 拒否 |
| T54 | approval後candidate/check/policy変更 | 失効 |
| T55 | approval期限/nonce再利用/actor偽装 | 拒否 |
| T56 | 二つのtaskが同じBへ統合 | CASで一方だけ成功 |
| T57 | update-ref成功直後DB更新前kill | refを照合し一度だけ確定 |
| T58 | integration targetが第三のSHA | uncertainで人間復旧 |
| T59 | Board phase0他席参照 | 未公開artifactにアクセス不可 |
| T60 | round投稿1席だけ完成 | barrier未開放 |
| T61 | 全席sealed | 全席に同時に公開可能 |
| T62 | cancel/restart後late post | epochで拒否 |
| T63 | failed席除外でfamily不足 | Board停止またはdegraded明記、要件はpassしない |
| T64 | majorityが少数案を無根拠排除 | memo validatorがcandidate保存要求 |
| T65 | premise audit不在 | conditional tag強制 |
| T66 | 5 rounds収束なし | 未解決cruxと残存案を出し打切り |
| T67 | 外部packetにdeny path/secret/サイズ超過 | 送信前拒否 |
| T68 | unknown API price | costをnull、0円とは表示しない |
| T69 | handoff引用digest不一致/範囲外 | 引用拒否 |
| T70 | native履歴取得不可 | limitations明記、架空の過去会話なし |
| T71 | backup中worker書込み | cutoff/spool扱いを記録、DB snapshot整合 |
| T72 | GC対象に未承認dirty worktree | 削除対象にしない |
| T73 | schema/capability更新 | compatibility lock不一致で停止 |
| T74 | fake evidenceでreal integrate | 拒否 |
| T75 | cancel後自動fallback provider | 実行しない |
| T76 | stdout ANSI/OSC制御文字 | escaped表示、端末side effectなし |
| T77 | malformed UTF-8 / 8MiB超frame | 明示protocol error |
| T78 | long requestがDB txnを保持 | transaction監視testで失敗 |
| T79 | dependency cycle / unresolved dependency | start拒否 |
| T80 | export bundleの欠落object/base | verifyで検出、未検証bundleを成功扱いしない |

test fixtureはsource repo、managed repo、worker spoolを毎回新しいtemporary rootに作る。Git user.name/emailはfixture repoのみへ設定し、利用者global configを変更しない。

## 16.3 Property-based testing

生成する値は、合法state/event列、同時command列、各seqの欠落/重複/並び替え、path、JSON、Board投稿順とする。検証property:

- integratedへ到達する全経路に、同じidentity/evidenceの有効なhuman approvalが存在する。
- writer ownershipの最大数は常に1。
- event replayの結果は、重複を除いた正順再生と一致する。
- candidateを変更した履歴のapprovalは再利用できない。
- Board未sealed roundの出力を次round packetへ含めない。
- CAS不一致でtarget refは変化しない。
- cancel後にnew attemptを暗黙作成しない。

race testは `sleep` の運頼みではなく、barrier/latch/fake clockでcritical sectionの順序を制御する。

## 16.4 障害注入point

`AW_TEST_FAULT_POINT` はtest buildだけで有効にする。値は `after_command_commit`、`after_workspace_create`、`after_worker_spawn`、`after_turn_write_before_response`、`after_artifact_fsync`、`before_candidate_commit`、`after_candidate_object_before_db`、`after_approval_consume`、`after_ref_update_before_db`、`after_board_post_before_barrier`。

production buildでこの環境変数を受理しない。test注入はexceptionだけでなくSIGKILLを使うcaseも含める。復旧時にデータを「片づけて成功」にするのではなく、期待したuncertainやrecovery_requiredをassertする。

## 16.5 性能・資源の初期目標

以下は設計予算であり測定結果ではない。

- 外部API待ちのないstatus/get: ローカルで通常100ms以内を目標。
- DB transaction: 通常50ms未満、500ms超を診断logへ。
- worker log live buffer: 最大8MiB、永続spoolはpolicy.maxLogBytes。
- frame最大8MiB、context packet既定512KiB、1 artifact既定64MiB。
- global active writers既定2、reviews2、Board1。providerごとのsemaphoreも適用。
- process memoryはOS管理方法によりenforced/observed/unknownを区別。観測しかできない環境をhard limitと表現しない。
- token/costの事後usageだけでは絶対予算を保証できない。1 request output上限と事前見積で抑え、測定不可能な課金上限は「best effort」と明記。

## 16.6 この配布物の参照testと製品testの違い

`verification/check_design.py` は本設計のschema、SQL制約、state table、approval binding、Board barrier、実Git CASを確認する**設計用参照test**である。将来のTypeScript製品実装が正しいこと、Codex/Herdr実機連携が成功すること、OS sandboxが要求通り動くことを証明しない。

本体実装後はT01〜T80とlive testを別途実施する。参照testの成功件数を、そのまま製品のcoverageやセキュリティ保証として報告してはいけない。

---

# 17. リリース・運用への受け入れ条件

R2を完成と呼ぶためのchecklist:

1. この仕様の必須機能とcontractが実装され、未実装commandは明確なerrorとなる。成功に見せるstubなし。
2. R0のreference/golden testsと、製品T01〜T80の実施結果が保存されている。
3. 対応OS・Node/Git/Codex/Herdr version・SQLite実version・protocol hashを明記する。
4. native laneはcooperative-localの限界を表示し、sandbox-verifiedへ誤分類しない。
5. 本物の小repoでmanaged/native各1件以上のend-to-end結果があり、approval前の統合拒否を確認する。
6. 外部モデルを使う場合は課金/egress許可とfamilyの実設定を確認する。未設定なら該当機能を正しく拒否する。
7. SIGKILL後のrecoveryとbackup復元の記録がある。
8. user's source working tree、ref、uncommitted changesに無断変更がない。
9. READMEに未対応・制約・security boundaryを記載し、rollback手順を提供する。
10. 利用者のGitHubにpush/PR作成を行わず、最初の成果物をローカルbundleで渡せる。

最終reportは `implemented / reference-tested / contract-tested / live-tested / not-tested / unsupported` を別欄にする。「全部できます」という宣言ではなく、versionと証拠への参照で完了を示す。


---

# 18. 根拠資料・確認範囲

確認日: **2026-11-05**。以下は外部製品の契約確認に用いた一次資料である。Agent WorkbenchのCLI名、DB、状態遷移、gate、approval binding、protocol bridge、resource limitsは**本設計の提案**であり、CodexやHerdrの既存仕様ではない。

| ID | 一次資料 | 使用範囲 |
|---|---|---|
| S1 | [Codex App Server](https://developers.openai.com/codex/app-server) | 公式API。schema生成、stdio protocol、thread/turn、command/exec、server approval、public history。 |
| S2 | [Herdr TUI CLI reference](https://herdr.dev/tui/docs/cli-reference/) | workspace、agent、worktree、CLI responseの形。 |
| S3 | [Herdr TUI Socket API](https://herdr.dev/tui/docs/socket-api/) | socket framing、schema capture、events、snapshot。 |
| S4 | [Herdr Rust wire schema (pinned commit)](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/api/schema/agents.rs) | AgentStartParams、AgentPromptParams、AgentInfoを実コードで確認。schema.rsも参照。 |
| S5 | [Git worktree documentation](https://git-scm.com/docs/git-worktree) | worktreeの作成・切離し・削除と共通repository。 |
| S6 | [SQLite WAL documentation](https://sqlite.org/wal.html) | 同一host要件とWAL-reset bug修正版。設計上はSQLite>=3.51.3を要求。 |
| S7 | [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output) | structured outputの制約。現在のガイドにはInteractions APIの例があり、generateContentと混同しない。 |
| S8 | [Gemini generateContent API reference](https://ai.google.dev/api/generate-content) | generateContent REST endpoint、generationConfig、responseMimeType、responseJsonSchema、finishReason。 |
| S9 | [Herdr Core](https://herdr.dev/core/) | Herdr TUIとCore/Appの区別。R2の実装対象はTUI adapter。 |
| S10 | [Codex sandbox and approvals](https://developers.openai.com/codex/agent-approvals-security) | sandbox/approvalの境界。実際の隔離成立は利用環境でcanary確認が必要。 |
| S11 | [Git update-ref](https://git-scm.com/docs/git-update-ref) | expected old OID付きref更新。 |
| S12 | [pi-agent-config Board (pinned commit)](https://github.com/pasky/pi-agent-config/blob/bb10b506a50befb3ea965fbbb7094a612621b32b/skills/board/SKILL.md) | 元の設計思想。blind、反証、非多数決、premise audit、fork without blending。 |
| S13 | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 採用候補のSQLite binding。package versionと内包SQLiteは実buildで固定・検査する。 |

## コード確認

Herdrの `src/api/mod.rs`、`src/api/schema.rs`、`src/api/schema/agents.rs` をGitHub connector経由で確認した。参照headは `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde`。実装は `master` の取得内容を確認しており、利用者のインストール済みversionと一致するとは限らない。

元のpi-agent-configの参照コミットは `bb10b506a50befb3ea965fbbb7094a612621b32b`。本設計はソースのコピーではなく、前の調査で確認した原則をCodex/Herdr向けに再設計したものである。

## 検証済みと未検証の境界

- 確認済み: 公開ドキュメント、上記Herdr Rust契約、配布SQL/schema、設計用参照test、実Gitによるローカル不変条件。
- 未検証: 利用者PCのインストール版、Codex/Herdr実機接続、モデル認証・課金、OS sandbox、Gemini実接続。
- 業務repo: この詳細設計作成時にはugo_hub等を調査・変更していない。check commandや実modelを未確認のまま固定していない。
- 外部APIの変更: 利用環境でschema captureとcontract testを実施し、compatibility lockを作成する。Webの「最新」だけで対応版と判定しない。


---

# 付録A. 機械可読契約の全文

以下は `contracts/` の実ファイルと同一内容。保存時は各ファイル名で分離する。

## A. 001_initial.sql

```sql
-- Agent Workbench schema v1. All timestamps are UTC epoch milliseconds.
-- Production: SQLite >= 3.51.3; local filesystem only; one daemon owns writes.
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE config_versions (
  digest TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('global','policy','check_plan','instructions','environment')),
  json TEXT NOT NULL CHECK(json_valid(json)),
  trusted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL UNIQUE,
  managed_git_dir TEXT NOT NULL UNIQUE,
  source_base_ref TEXT NOT NULL,
  source_base_sha TEXT NOT NULL,
  integration_ref TEXT NOT NULL,
  integration_sha TEXT NOT NULL,
  object_format TEXT NOT NULL CHECK(object_format IN ('sha1','sha256')),
  policy_digest TEXT NOT NULL REFERENCES config_versions(digest),
  created_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('draft','ready','allocating','running','waiting_human','freezing','verifying','reviewing',
     'changes_required','awaiting_approval','integrating','integrated','cancelled','failed','recovery_required')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
  spec_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL REFERENCES config_versions(digest),
  active_candidate_id TEXT REFERENCES candidates(id),
  blocked_json TEXT CHECK(blocked_json IS NULL OR json_valid(blocked_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_by_state ON tasks(state, updated_at_ms);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  dependency_id TEXT NOT NULL REFERENCES tasks(id),
  required_candidate_sha TEXT,
  PRIMARY KEY(task_id, dependency_id),
  CHECK(task_id <> dependency_id)
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  task_id TEXT REFERENCES tasks(id),
  role TEXT NOT NULL CHECK(role IN ('writer','check','review','board','experiment')),
  path TEXT NOT NULL UNIQUE,
  branch_ref TEXT UNIQUE,
  base_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','creating','ready','frozen','quarantined','removed')),
  created_at_ms INTEGER NOT NULL,
  removed_at_ms INTEGER
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  workspace_id TEXT REFERENCES workspaces(id),
  role TEXT NOT NULL CHECK(role IN ('implement','check','review','board','handoff')),
  generation INTEGER NOT NULL CHECK(generation > 0),
  driver TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  state TEXT NOT NULL CHECK(state IN
    ('created','starting','running','waiting_input','stopping','completed','failed','cancelled','unknown')),
  writes_workspace INTEGER NOT NULL CHECK(writes_workspace IN (0,1)),
  worker_instance_id TEXT,
  worker_socket TEXT,
  native_session_id TEXT,
  native_turn_id TEXT,
  presentation_json TEXT CHECK(presentation_json IS NULL OR json_valid(presentation_json)),
  process_identity_json TEXT CHECK(process_identity_json IS NULL OR json_valid(process_identity_json)),
  deadline_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json))
) STRICT;
CREATE UNIQUE INDEX one_active_writer ON attempts(workspace_id)
WHERE writes_workspace = 1 AND state IN ('created','starting','running','waiting_input','stopping','unknown');

CREATE TABLE leases (
  resource TEXT PRIMARY KEY,
  owner_attempt_id TEXT REFERENCES attempts(id),
  owner_instance_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  heartbeat_at_ms INTEGER NOT NULL,
  observed_expiry_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('held','recovery_required','released'))
) STRICT;

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','worker','system')),
  actor_id TEXT NOT NULL,
  method TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK(json_valid(params_json)),
  params_digest TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  expected_version INTEGER,
  state TEXT NOT NULL CHECK(state IN ('pending','executing','completed','failed','uncertain')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX commands_pending ON commands(state, created_at_ms);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  attempt_id TEXT REFERENCES attempts(id),
  source_seq INTEGER,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(attempt_id, source_seq)
) STRICT;
CREATE INDEX events_by_aggregate ON events(aggregate_id, seq);

CREATE TABLE worker_offsets (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  accepted_source_seq INTEGER NOT NULL DEFAULT 0 CHECK(accepted_source_seq >= 0),
  worker_instance_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE artifacts (
  digest TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  classification TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','restricted')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE artifact_links (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  digest TEXT NOT NULL REFERENCES artifacts(digest),
  PRIMARY KEY(owner_type, owner_id, purpose, digest)
) STRICT;

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL CHECK(generation > 0),
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
  identity_digest TEXT NOT NULL UNIQUE,
  base_sha TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  check_plan_digest TEXT NOT NULL REFERENCES config_versions(digest),
  manifest_digest TEXT NOT NULL REFERENCES artifacts(digest),
  state TEXT NOT NULL CHECK(state IN ('frozen','stale','integrated','rejected')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(task_id, generation)
) STRICT;

CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  check_key TEXT NOT NULL,
  execution_number INTEGER NOT NULL CHECK(execution_number > 0),
  attempt_id TEXT REFERENCES attempts(id),
  state TEXT NOT NULL CHECK(state IN ('queued','running','passed','failed','timed_out','cancelled','unknown')),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  command_digest TEXT NOT NULL,
  environment_digest TEXT NOT NULL,
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK(timed_out IN (0,1)),
  output_digest TEXT REFERENCES artifacts(digest),
  result_digest TEXT REFERENCES artifacts(digest),
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  UNIQUE(candidate_id, check_key, execution_number)
) STRICT;

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  attempt_id TEXT REFERENCES attempts(id),
  profile_id TEXT NOT NULL,
  execution_number INTEGER NOT NULL DEFAULT 1 CHECK(execution_number > 0),
  provider_id TEXT NOT NULL,
  training_family TEXT NOT NULL,
  model_id TEXT NOT NULL,
  context_digest TEXT NOT NULL,
  output_digest TEXT REFERENCES artifacts(digest),
  state TEXT NOT NULL CHECK(state IN ('queued','running','valid','invalid','failed','incomplete')),
  verdict TEXT CHECK(verdict IN ('pass','request_changes','insufficient_evidence')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(candidate_id, profile_id, execution_number)
) STRICT;

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id),
  local_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('blocker','high','medium','low')),
  fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  UNIQUE(review_id, local_key)
) STRICT;

CREATE TABLE finding_dispositions (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  disposition_version INTEGER NOT NULL CHECK(disposition_version > 0),
  disposition TEXT NOT NULL CHECK(disposition IN ('open','confirmed','false_positive','risk_accepted')),
  reason TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','independent_reviewer','system')),
  actor_id TEXT NOT NULL,
  evidence_digest TEXT REFERENCES artifacts(digest),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(finding_id, disposition_version)
) STRICT;
CREATE INDEX finding_dispositions_history ON finding_dispositions(finding_id, disposition_version);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  action TEXT NOT NULL CHECK(action IN ('integrate','publish','risk_accept')),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  binding_digest TEXT NOT NULL UNIQUE,
  evidence_digest TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','granted','denied','revoked','expired','consumed')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id),
  human_actor_id TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  granted_at_ms INTEGER NOT NULL,
  consumed_by_command_id TEXT UNIQUE REFERENCES commands(id),
  revoked_at_ms INTEGER
) STRICT;

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),
  target_ref TEXT NOT NULL,
  expected_old_sha TEXT NOT NULL,
  new_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','applied','failed','uncertain')),
  created_at_ms INTEGER NOT NULL,
  confirmed_at_ms INTEGER
) STRICT;

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  repo_id TEXT REFERENCES repositories(id),
  charter_json TEXT NOT NULL CHECK(json_valid(charter_json)),
  charter_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('created','blind_collect','debating','auditing','synthesizing','completed','failed','cancelled')),
  current_round INTEGER NOT NULL DEFAULT 0 CHECK(current_round >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  memo_digest TEXT REFERENCES artifacts(digest),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE board_seats (
  board_id TEXT NOT NULL REFERENCES boards(id),
  seat_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  training_family TEXT NOT NULL,
  native_session_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','failed','withdrawn','finished')),
  PRIMARY KEY(board_id, seat_id)
) STRICT;

CREATE TABLE board_rounds (
  board_id TEXT NOT NULL REFERENCES boards(id),
  round_number INTEGER NOT NULL CHECK(round_number >= 0),
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('collecting','sealed','aborted')),
  expected_seats_json TEXT NOT NULL CHECK(json_valid(expected_seats_json)),
  input_manifest_digest TEXT REFERENCES artifacts(digest),
  seal_digest TEXT REFERENCES artifacts(digest),
  deadline_at_ms INTEGER NOT NULL,
  sealed_at_ms INTEGER,
  PRIMARY KEY(board_id, round_number)
) STRICT;

CREATE TABLE board_posts (
  board_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  seat_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  output_digest TEXT NOT NULL REFERENCES artifacts(digest),
  accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(board_id, round_number, seat_id),
  FOREIGN KEY(board_id, round_number) REFERENCES board_rounds(board_id, round_number),
  FOREIGN KEY(board_id, seat_id) REFERENCES board_seats(board_id, seat_id)
) STRICT;

CREATE TABLE board_access_grants (
  board_id TEXT NOT NULL REFERENCES boards(id),
  seat_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest),
  granted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(board_id, seat_id, round_number, artifact_digest),
  FOREIGN KEY(board_id, seat_id) REFERENCES board_seats(board_id, seat_id)
) STRICT;

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  source_attempt_id TEXT NOT NULL REFERENCES attempts(id),
  target_attempt_id TEXT REFERENCES attempts(id),
  cutoff_event_seq INTEGER NOT NULL CHECK(cutoff_event_seq >= 0),
  output_digest TEXT NOT NULL REFERENCES artifacts(digest),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_immutable_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER artifacts_immutable_update BEFORE UPDATE ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;
CREATE TRIGGER candidates_identity_immutable BEFORE UPDATE OF
  identity_json, identity_digest, candidate_sha, tree_sha, base_sha,
  check_plan_digest, manifest_digest ON candidates
BEGIN SELECT RAISE(ABORT, 'candidate identity is immutable'); END;
```

## A. approval-binding.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/approval-binding.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "action": {
      "type": "string",
      "enum": [
        "integrate",
        "publish",
        "risk_accept"
      ]
    },
    "repoId": {
      "type": "string",
      "pattern": "^[a-z]+_[0-9a-f]{32}$"
    },
    "taskId": {
      "type": "string",
      "pattern": "^[a-z]+_[0-9a-f]{32}$"
    },
    "candidateIdentityDigest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "evidenceDigest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "targetRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    },
    "expectedBaseSha": {
      "type": "string",
      "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
    },
    "expiresAtMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "nonce": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    }
  },
  "required": [
    "schemaVersion",
    "action",
    "repoId",
    "taskId",
    "candidateIdentityDigest",
    "evidenceDigest",
    "targetRef",
    "expectedBaseSha",
    "expiresAtMs",
    "nonce"
  ],
  "additionalProperties": false
}
```

## A. board-charter.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/board-charter.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "question": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "shape": {
      "type": "string",
      "enum": [
        "ideas",
        "decide",
        "diagnose",
        "estimate"
      ]
    },
    "decisionUse": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8000
    },
    "contextArtifacts": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^sha256:[0-9a-f]{64}$"
      },
      "minItems": 1,
      "maxItems": 1000
    },
    "seats": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "seatId": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{0,30}$"
          },
          "profile": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          }
        },
        "required": [
          "seatId",
          "profile"
        ],
        "additionalProperties": false
      },
      "minItems": 2,
      "maxItems": 5
    },
    "minimumTrainingFamilies": {
      "type": "integer",
      "minimum": 1,
      "maximum": 5
    },
    "minimumRounds": {
      "type": "integer",
      "minimum": 2,
      "maximum": 5
    },
    "maximumRounds": {
      "type": "integer",
      "minimum": 2,
      "maximum": 5
    },
    "roundDeadlineSeconds": {
      "type": "integer",
      "minimum": 60,
      "maximum": 7200
    },
    "maxOutputTokensPerSeatRound": {
      "type": "integer",
      "minimum": 1000,
      "maximum": 20000
    },
    "maxTotalOutputTokens": {
      "type": "integer",
      "minimum": 10000,
      "maximum": 1000000
    },
    "failurePolicy": {
      "type": "string",
      "enum": [
        "stop",
        "continue-with-two"
      ]
    },
    "factChecks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "checkId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          }
        },
        "required": [
          "id",
          "checkId"
        ],
        "additionalProperties": false
      },
      "minItems": 0,
      "maxItems": 50
    },
    "isolation": {
      "type": "string",
      "enum": [
        "sandbox-verified",
        "cooperative-local"
      ]
    }
  },
  "required": [
    "schemaVersion",
    "question",
    "shape",
    "decisionUse",
    "contextArtifacts",
    "seats",
    "minimumTrainingFamilies",
    "minimumRounds",
    "maximumRounds",
    "roundDeadlineSeconds",
    "maxOutputTokensPerSeatRound",
    "maxTotalOutputTokens",
    "failurePolicy",
    "factChecks",
    "isolation"
  ],
  "additionalProperties": false
}
```

## A. board-post.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/board-post.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300
          },
          "proposal": {
            "type": "string",
            "minLength": 1,
            "maxLength": 12000
          },
          "decisivePremises": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4000
            },
            "minItems": 1,
            "maxItems": 30
          },
          "failureModes": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4000
            },
            "minItems": 1,
            "maxItems": 30
          },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "file",
                    "check",
                    "artifact",
                    "source"
                  ]
                },
                "reference": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                },
                "digest": {
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^sha256:[0-9a-f]{64}$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "startLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "endLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "explanation": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                }
              },
              "required": [
                "kind",
                "reference",
                "digest",
                "startLine",
                "endLine",
                "explanation"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 50
          },
          "forkedFrom": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1,
                "maxLength": 80
              },
              {
                "type": "null"
              }
            ]
          },
          "estimate": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "value": {
                    "type": "number"
                  },
                  "lower": {
                    "type": "number"
                  },
                  "upper": {
                    "type": "number"
                  },
                  "unit": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 80
                  },
                  "assumptions": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 4000
                    },
                    "minItems": 1,
                    "maxItems": 30
                  }
                },
                "required": [
                  "value",
                  "lower",
                  "upper",
                  "unit",
                  "assumptions"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "title",
          "proposal",
          "decisivePremises",
          "failureModes",
          "evidence",
          "forkedFrom",
          "estimate"
        ],
        "additionalProperties": false
      },
      "minItems": 0,
      "maxItems": 20
    },
    "objections": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "targetItem": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "claim": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "file",
                    "check",
                    "artifact",
                    "source"
                  ]
                },
                "reference": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                },
                "digest": {
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^sha256:[0-9a-f]{64}$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "startLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "endLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "explanation": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                }
              },
              "required": [
                "kind",
                "reference",
                "digest",
                "startLine",
                "endLine",
                "explanation"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 30
          },
          "classification": {
            "type": "string",
            "enum": [
              "fatal_candidate",
              "tradeoff",
              "question"
            ]
          }
        },
        "required": [
          "targetItem",
          "claim",
          "evidence",
          "classification"
        ],
        "additionalProperties": false
      },
      "minItems": 0,
      "maxItems": 100
    },
    "concessions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "itemId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "namedReason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          }
        },
        "required": [
          "itemId",
          "namedReason"
        ],
        "additionalProperties": false
      },
      "minItems": 0,
      "maxItems": 30
    },
    "premiseAudits": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "itemId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "premise": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000
          },
          "status": {
            "type": "string",
            "enum": [
              "verified",
              "refuted",
              "unverified"
            ]
          },
          "whatEstablished": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "whatNotEstablished": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "file",
                    "check",
                    "artifact",
                    "source"
                  ]
                },
                "reference": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                },
                "digest": {
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^sha256:[0-9a-f]{64}$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "startLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "endLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "explanation": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                }
              },
              "required": [
                "kind",
                "reference",
                "digest",
                "startLine",
                "endLine",
                "explanation"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 30
          }
        },
        "required": [
          "itemId",
          "premise",
          "status",
          "whatEstablished",
          "whatNotEstablished",
          "evidence"
        ],
        "additionalProperties": false
      },
      "minItems": 0,
      "maxItems": 100
    },
    "position": {
      "type": "object",
      "properties": {
        "champion": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 80
            },
            {
              "type": "null"
            }
          ]
        },
        "coPicks": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "minItems": 0,
          "maxItems": 2
        },
        "dropCondition": {
          "type": "string",
          "minLength": 1,
          "maxLength": 8000
        },
        "changeReason": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 8000
            },
            {
              "type": "null"
            }
          ]
        },
        "deadItems": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "itemId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8000
              }
            },
            "required": [
              "itemId",
              "reason"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 100
        },
        "openCruxes": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "minItems": 0,
          "maxItems": 30
        },
        "pitch": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4000
        }
      },
      "required": [
        "champion",
        "coPicks",
        "dropCondition",
        "changeReason",
        "deadItems",
        "openCruxes",
        "pitch"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "schemaVersion",
    "items",
    "objections",
    "concessions",
    "premiseAudits",
    "position"
  ],
  "additionalProperties": false
}
```

## A. candidate-identity.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/candidate-identity.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "repoId": {
      "type": "string",
      "pattern": "^[a-z]+_[0-9a-f]{32}$"
    },
    "taskId": {
      "type": "string",
      "pattern": "^[a-z]+_[0-9a-f]{32}$"
    },
    "generation": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "sourceBaseSha": {
      "type": "string",
      "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
    },
    "integrationBaseSha": {
      "type": "string",
      "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
    },
    "candidateSha": {
      "type": "string",
      "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
    },
    "candidateTreeSha": {
      "type": "string",
      "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
    },
    "specDigest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "policyDigest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "checkPlanDigest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "instructionsDigest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "contextDigest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "environmentDigest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    }
  },
  "required": [
    "schemaVersion",
    "repoId",
    "taskId",
    "generation",
    "sourceBaseSha",
    "integrationBaseSha",
    "candidateSha",
    "candidateTreeSha",
    "specDigest",
    "policyDigest",
    "checkPlanDigest",
    "instructionsDigest",
    "contextDigest",
    "environmentDigest"
  ],
  "additionalProperties": false
}
```

## A. handoff.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/handoff.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "goal": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "taskId": {
      "type": "string",
      "pattern": "^[a-z]+_[0-9a-f]{32}$"
    },
    "candidateIdentityDigest": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^sha256:[0-9a-f]{64}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "sourceAttemptId": {
      "type": "string",
      "pattern": "^[a-z]+_[0-9a-f]{32}$"
    },
    "sourceEventCutoff": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "facts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "file",
                    "check",
                    "artifact",
                    "source"
                  ]
                },
                "reference": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                },
                "digest": {
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^sha256:[0-9a-f]{64}$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "startLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "endLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "explanation": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                }
              },
              "required": [
                "kind",
                "reference",
                "digest",
                "startLine",
                "endLine",
                "explanation"
              ],
              "additionalProperties": false
            },
            "minItems": 1,
            "maxItems": 30
          }
        },
        "required": [
          "statement",
          "evidence"
        ],
        "additionalProperties": false
      },
      "minItems": 0
    },
    "decisions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "statement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "file",
                    "check",
                    "artifact",
                    "source"
                  ]
                },
                "reference": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                },
                "digest": {
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^sha256:[0-9a-f]{64}$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "startLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "endLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "explanation": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                }
              },
              "required": [
                "kind",
                "reference",
                "digest",
                "startLine",
                "endLine",
                "explanation"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 30
          }
        },
        "required": [
          "statement",
          "reason",
          "evidence"
        ],
        "additionalProperties": false
      },
      "minItems": 0
    },
    "openQuestions": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 8000
      },
      "minItems": 0
    },
    "nextActions": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 8000
      },
      "minItems": 1
    },
    "nonGoals": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 8000
      },
      "minItems": 0
    },
    "sourceRefs": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "minItems": 1
    }
  },
  "required": [
    "schemaVersion",
    "goal",
    "taskId",
    "candidateIdentityDigest",
    "sourceAttemptId",
    "sourceEventCutoff",
    "facts",
    "decisions",
    "openQuestions",
    "nextActions",
    "nonGoals",
    "sourceRefs"
  ],
  "additionalProperties": false
}
```

## A. implementation-output.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/implementation-output.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8000
    },
    "declaredOutcome": {
      "type": "string",
      "enum": [
        "ready_for_verification",
        "needs_input",
        "unable_to_complete"
      ]
    },
    "changedPaths": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "minItems": 0,
      "maxItems": 5000
    },
    "requirementsAddressed": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40
      },
      "minItems": 0,
      "maxItems": 200
    },
    "testsClaimed": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
      },
      "minItems": 0,
      "maxItems": 100
    },
    "knownLimitations": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000
      },
      "minItems": 0,
      "maxItems": 100
    },
    "questionForHuman": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 8000
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "schemaVersion",
    "summary",
    "declaredOutcome",
    "changedPaths",
    "requirementsAddressed",
    "testsClaimed",
    "knownLimitations",
    "questionForHuman"
  ],
  "additionalProperties": false
}
```

## A. model-profile.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/model-profile.schema.json",
  "type": "object",
  "properties": {
    "driver": {
      "type": "string",
      "enum": [
        "codex-app-server",
        "gemini-api",
        "fake"
      ]
    },
    "providerId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "trainingFamily": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "modelId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        {
          "type": "null"
        }
      ]
    },
    "reasoningEffort": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        {
          "type": "null"
        }
      ]
    },
    "maxOutputTokens": {
      "type": "integer",
      "minimum": 256,
      "maximum": 1000000
    },
    "contextBytesLimit": {
      "type": "integer",
      "minimum": 4096,
      "maximum": 8000000
    }
  },
  "required": [
    "driver",
    "providerId",
    "trainingFamily",
    "modelId",
    "reasoningEffort",
    "maxOutputTokens",
    "contextBytesLimit"
  ],
  "additionalProperties": false
}
```

## A. ports.ts

```typescript
/**
 * Agent Workbench ports, design contract v1.
 * This file defines internal APIs, NOT the external Codex/Herdr wire protocol.
 * Generate external protocol types from the installed binaries.
 */
export type Id = string;
export type Digest = `sha256:${string}`;
export type GitOid = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Actor =
  | { kind: "human"; id: Id; connectionId: Id }
  | { kind: "system"; id: Id }
  | { kind: "worker"; id: Id; attemptId: Id; workerInstanceId: Id };

export interface AwError {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, Json>;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: AwError };
export interface ArtifactRef { digest: Digest; mediaType: string; sizeBytes: number }
export interface ModelSelection {
  profileId: string;
  profileDigest: Digest;
  providerId: string;
  trainingFamily: string;
  modelId: string;
  reasoningEffort: string | null;
}
export interface CapabilityReport {
  driver: string;
  version: string;
  schemaDigest: Digest | null;
  freshSession: boolean;
  structuredOutput: boolean;
  interrupt: boolean;
  steer: boolean;
  publicHistory: boolean;
  sandboxedCommands: boolean;
  verifiedIsolation: boolean;
  issues: string[];
}
export interface AgentRequest {
  attemptId: Id;
  workerInstanceId: Id;
  role: "implement" | "review" | "board" | "handoff";
  cwd: string | null;
  model: ModelSelection;
  context: ArtifactRef;
  outputSchema: Json;
  outputTokenLimit: number;
  deadlineAtMs: number;
  isolation: "cooperative-local" | "sandbox-verified";
  permissions: {
    writableRoots: string[];
    readableRoots: string[];
    network: "deny" | "explicit-allowlist";
    allowHosts: string[];
  };
}
export interface SessionHandle {
  attemptId: Id;
  driver: string;
  threadId: string | null;
  turnId: string | null;
  processIdentityDigest: Digest;
}
export interface AgentEvent {
  attemptId: Id;
  workerInstanceId: Id;
  sourceSeq: number;
  occurredAtMs: number;
  type: string;
  data: Record<string, Json>;
}
export interface PublicHistoryPage {
  items: { itemId: string; publicText: string; artifact: ArtifactRef | null }[];
  nextCursor: string | null;
}
export interface AgentDriver {
  probe(signal: AbortSignal): Promise<Result<CapabilityReport>>;
  startFresh(request: AgentRequest, signal: AbortSignal): Promise<Result<SessionHandle>>;
  events(handle: SessionHandle, afterSourceSeq: number, signal: AbortSignal): AsyncIterable<AgentEvent>;
  steer(handle: SessionHandle, expectedTurnId: string, text: string, signal: AbortSignal): Promise<Result<void>>;
  interrupt(handle: SessionHandle, signal: AbortSignal): Promise<Result<void>>;
  readPublicHistory(handle: SessionHandle, cursor: string | null, signal: AbortSignal): Promise<Result<PublicHistoryPage>>;
  close(handle: SessionHandle, signal: AbortSignal): Promise<Result<void>>;
}
export interface PresentationHandle {
  variant: "herdr-tui" | "none";
  workspaceId: string | null;
  paneId: string | null;
  agentName: string | null;
  revision: number | null;
}
export interface ManagedPresentationRequest {
  cwd: string;
  label: string;
  workerExecutable: string;
  ticketPath: string; // host-generated path; never arbitrary model command
}
export interface NativePresentationRequest {
  cwd: string;
  label: string;
  model: ModelSelection;
  codexHome: string;
  initialPrompt: ArtifactRef;
}
export interface PresentationDriver {
  probe(signal: AbortSignal): Promise<Result<CapabilityReport>>;
  startManaged(request: ManagedPresentationRequest, signal: AbortSignal): Promise<Result<PresentationHandle>>;
  startNative(request: NativePresentationRequest, signal: AbortSignal): Promise<Result<PresentationHandle>>;
  attach(handle: PresentationHandle, signal: AbortSignal): Promise<Result<void>>;
  getStatus(handle: PresentationHandle, signal: AbortSignal): Promise<Result<Record<string, Json>>>;
  closePresentation(handle: PresentationHandle, signal: AbortSignal): Promise<Result<void>>;
}
export interface CheckRequest {
  attemptId: Id;
  candidateIdentityDigest: Digest;
  checkId: string;
  cwd: string;
  argv: string[];
  environment: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  expectedArtifactPaths: string[];
  network: "deny" | "explicit-allowlist";
  allowHosts: string[];
}
export interface CheckResult {
  attemptId: Id;
  candidateIdentityDigest: Digest;
  checkId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  sourceUnchanged: boolean;
  isolationVerified: boolean;
  simulated: boolean;
  output: ArtifactRef;
  outputs: ArtifactRef[];
}
export interface CheckRunner {
  execute(request: CheckRequest, signal: AbortSignal): Promise<Result<CheckResult>>;
}
export interface WorkspaceRecord {
  id: Id;
  taskId: Id;
  path: string;
  branchRef: string | null;
  baseSha: GitOid;
  role: "writer" | "check" | "review" | "board" | "experiment";
}
export interface CandidateRecord {
  id: Id;
  taskId: Id;
  generation: number;
  identity: Json;
  identityDigest: Digest;
  integrationBaseSha: GitOid;
  candidateSha: GitOid;
  candidateTreeSha: GitOid;
}
export interface GateDecision {
  passed: boolean;
  candidateIdentityDigest: Digest;
  evidenceDigest: Digest;
  blockingReasons: { code: string; reference: string | null; message: string }[];
}
export interface ApprovalBinding {
  schemaVersion: 1;
  action: "integrate" | "publish" | "risk_accept";
  repoId: Id;
  taskId: Id;
  candidateIdentityDigest: Digest;
  evidenceDigest: Digest;
  targetRef: string;
  expectedBaseSha: GitOid;
  expiresAtMs: number;
  nonce: string;
}
export interface IntegrationRecord {
  id: Id;
  commandId: Id;
  targetRef: string;
  expectedOldSha: GitOid;
  newSha: GitOid;
  state: "prepared" | "applied" | "failed" | "uncertain";
}
export interface StateStore {
  transact<T>(fn: () => T): T; // synchronous, no await or I/O inside
  appendEvent(aggregateId: Id, expectedVersion: number, type: string, payload: Json, actor: Actor): Result<number>;
  loadCandidate(id: Id): Result<CandidateRecord>;
  reserveWorkspace(record: WorkspaceRecord): Result<void>;
  prepareIntegration(record: IntegrationRecord): Result<void>;
}
export interface ArtifactStore {
  put(bytes: Uint8Array, mediaType: string, maximumBytes: number): Promise<Result<ArtifactRef>>;
  readVerified(digest: Digest): Promise<Result<Uint8Array>>;
}
export interface GitPort {
  createWorkspace(record: WorkspaceRecord): Promise<Result<void>>;
  freezeSnapshot(workspace: WorkspaceRecord, expectedBase: GitOid): Promise<Result<{ commit: GitOid; tree: GitOid }>>;
  compareAndSwapRef(targetRef: string, oldSha: GitOid, newSha: GitOid): Promise<Result<void>>;
  readRef(targetRef: string): Promise<Result<GitOid>>;
}
```

## A. project-policy.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/project-policy.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "sourceBaseRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "defaultInteraction": {
      "type": "string",
      "enum": [
        "managed",
        "native"
      ]
    },
    "presentation": {
      "type": "string",
      "enum": [
        "herdr-tui",
        "none"
      ]
    },
    "checks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "argv": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "minItems": 1,
            "maxItems": 100
          },
          "cwd": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "required": {
            "type": "boolean"
          },
          "timeoutSeconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 7200
          },
          "maxOutputBytes": {
            "type": "integer",
            "minimum": 1024,
            "maximum": 100000000
          },
          "env": {
            "type": "object",
            "properties": {
              "pass": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 200
                },
                "minItems": 0
              },
              "set": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                }
              }
            },
            "required": [
              "pass",
              "set"
            ],
            "additionalProperties": false
          },
          "network": {
            "type": "string",
            "enum": [
              "deny",
              "explicit-allowlist"
            ]
          },
          "allowHosts": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 253
            },
            "minItems": 0
          },
          "expectedArtifacts": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "minItems": 0
          },
          "mutatesSource": {
            "const": false
          }
        },
        "required": [
          "id",
          "argv",
          "cwd",
          "required",
          "timeoutSeconds",
          "maxOutputBytes",
          "env",
          "network",
          "allowHosts",
          "expectedArtifacts",
          "mutatesSource"
        ],
        "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 100
    },
    "bootstrap": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "argv": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "minItems": 1,
            "maxItems": 100
          },
          "cwd": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "timeoutSeconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 7200
          },
          "network": {
            "type": "string",
            "enum": [
              "deny",
              "explicit-allowlist"
            ]
          },
          "allowHosts": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 253
            },
            "minItems": 0
          }
        },
        "required": [
          "argv",
          "cwd",
          "timeoutSeconds",
          "network",
          "allowHosts"
        ],
        "additionalProperties": false
      },
      "minItems": 0,
      "maxItems": 20
    },
    "review": {
      "type": "object",
      "properties": {
        "minimumReviewers": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        },
        "minimumTrainingFamilies": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        },
        "blockSeverities": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "blocker",
              "high",
              "medium",
              "low"
            ]
          },
          "minItems": 1,
          "maxItems": 4
        },
        "allowIncomplete": {
          "const": false
        },
        "maxRepairCycles": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10
        }
      },
      "required": [
        "minimumReviewers",
        "minimumTrainingFamilies",
        "blockSeverities",
        "allowIncomplete",
        "maxRepairCycles"
      ],
      "additionalProperties": false
    },
    "riskRules": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "paths": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 1024
            },
            "minItems": 1
          },
          "risk": {
            "type": "string",
            "enum": [
              "standard",
              "high"
            ]
          },
          "requiredCheckIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 80
            },
            "minItems": 0
          },
          "minimumTrainingFamilies": {
            "type": "integer",
            "minimum": 1,
            "maximum": 5
          }
        },
        "required": [
          "paths",
          "risk",
          "requiredCheckIds",
          "minimumTrainingFamilies"
        ],
        "additionalProperties": false
      },
      "minItems": 0,
      "maxItems": 100
    },
    "egress": {
      "type": "object",
      "properties": {
        "allowedProviders": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "minItems": 0
        },
        "allowedPathPatterns": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1024
          },
          "minItems": 0
        },
        "deniedPathPatterns": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1024
          },
          "minItems": 0
        },
        "maxBytesPerRequest": {
          "type": "integer",
          "minimum": 4096,
          "maximum": 8000000
        }
      },
      "required": [
        "allowedProviders",
        "allowedPathPatterns",
        "deniedPathPatterns",
        "maxBytesPerRequest"
      ],
      "additionalProperties": false
    },
    "integration": {
      "type": "object",
      "properties": {
        "mode": {
          "const": "managed-ref"
        },
        "requireHumanApproval": {
          "const": true
        },
        "approvalTtlSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 86400
        },
        "publishEnabled": {
          "type": "boolean"
        }
      },
      "required": [
        "mode",
        "requireHumanApproval",
        "approvalTtlSeconds",
        "publishEnabled"
      ],
      "additionalProperties": false
    },
    "isolation": {
      "type": "string",
      "enum": [
        "cooperative-local",
        "sandbox-verified"
      ]
    },
    "limits": {
      "type": "object",
      "properties": {
        "maxActiveWriters": {
          "type": "integer",
          "minimum": 1,
          "maximum": 16
        },
        "maxActiveReviews": {
          "type": "integer",
          "minimum": 1,
          "maximum": 16
        },
        "maxActiveBoards": {
          "type": "integer",
          "minimum": 1,
          "maximum": 4
        },
        "maxTaskDiskBytes": {
          "type": "integer",
          "minimum": 1000000,
          "maximum": 9007199254740991
        },
        "maxLogBytes": {
          "type": "integer",
          "minimum": 1024,
          "maximum": 9007199254740991
        },
        "allowNestedDelegation": {
          "const": false
        }
      },
      "required": [
        "maxActiveWriters",
        "maxActiveReviews",
        "maxActiveBoards",
        "maxTaskDiskBytes",
        "maxLogBytes",
        "allowNestedDelegation"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "schemaVersion",
    "sourceBaseRef",
    "defaultInteraction",
    "presentation",
    "checks",
    "bootstrap",
    "review",
    "riskRules",
    "egress",
    "integration",
    "isolation",
    "limits"
  ],
  "additionalProperties": false
}
```

## A. review-output.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/review-output.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8000
    },
    "verdict": {
      "type": "string",
      "enum": [
        "pass",
        "request_changes",
        "insufficient_evidence"
      ]
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "pattern": "^F[1-9][0-9]*$"
          },
          "severity": {
            "type": "string",
            "enum": [
              "blocker",
              "high",
              "medium",
              "low"
            ]
          },
          "category": {
            "type": "string",
            "enum": [
              "correctness",
              "security",
              "reliability",
              "compatibility",
              "performance",
              "maintainability",
              "testing"
            ]
          },
          "path": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              {
                "type": "null"
              }
            ]
          },
          "startLine": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "endLine": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "claim": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000
          },
          "rationale": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "reproduction": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8000
          },
          "requirementIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 40
            },
            "minItems": 0
          },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "file",
                    "check",
                    "artifact",
                    "source"
                  ]
                },
                "reference": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                },
                "digest": {
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^sha256:[0-9a-f]{64}$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "startLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "endLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "explanation": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                }
              },
              "required": [
                "kind",
                "reference",
                "digest",
                "startLine",
                "endLine",
                "explanation"
              ],
              "additionalProperties": false
            },
            "minItems": 1,
            "maxItems": 30
          },
          "evidenceStrength": {
            "type": "string",
            "enum": [
              "demonstrated",
              "supported",
              "hypothesis"
            ]
          }
        },
        "required": [
          "key",
          "severity",
          "category",
          "path",
          "startLine",
          "endLine",
          "claim",
          "rationale",
          "reproduction",
          "requirementIds",
          "evidence",
          "evidenceStrength"
        ],
        "additionalProperties": false
      },
      "minItems": 0,
      "maxItems": 200
    },
    "coverage": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "status": {
            "type": "string",
            "enum": [
              "complete",
              "partial",
              "not_reviewed"
            ]
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000
          }
        },
        "required": [
          "path",
          "status",
          "reason"
        ],
        "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 5000
    },
    "requirementCoverage": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "requirementId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40
          },
          "status": {
            "type": "string",
            "enum": [
              "supported",
              "contradicted",
              "unknown"
            ]
          },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "file",
                    "check",
                    "artifact",
                    "source"
                  ]
                },
                "reference": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096
                },
                "digest": {
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^sha256:[0-9a-f]{64}$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "startLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "endLine": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "explanation": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                }
              },
              "required": [
                "kind",
                "reference",
                "digest",
                "startLine",
                "endLine",
                "explanation"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 30
          }
        },
        "required": [
          "requirementId",
          "status",
          "evidence"
        ],
        "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 200
    },
    "openQuestions": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000
      },
      "minItems": 0,
      "maxItems": 100
    }
  },
  "required": [
    "schemaVersion",
    "summary",
    "verdict",
    "findings",
    "coverage",
    "requirementCoverage",
    "openQuestions"
  ],
  "additionalProperties": false
}
```

## A. state-machine.json

```json
{
  "schemaVersion": 1,
  "taskStates": [
    "draft",
    "ready",
    "allocating",
    "running",
    "waiting_human",
    "freezing",
    "verifying",
    "reviewing",
    "changes_required",
    "awaiting_approval",
    "integrating",
    "integrated",
    "cancelled",
    "failed",
    "recovery_required"
  ],
  "runStates": [
    "created",
    "starting",
    "running",
    "waiting_input",
    "stopping",
    "completed",
    "failed",
    "cancelled",
    "unknown"
  ],
  "terminalTaskStates": [
    "integrated",
    "cancelled"
  ],
  "transitions": [
    {
      "from": "draft",
      "event": "TASK_SUBMITTED",
      "to": "ready"
    },
    {
      "from": "ready",
      "event": "START_REQUESTED",
      "to": "allocating"
    },
    {
      "from": "allocating",
      "event": "WORKER_READY",
      "to": "running"
    },
    {
      "from": "running",
      "event": "INPUT_REQUIRED",
      "to": "waiting_human"
    },
    {
      "from": "waiting_human",
      "event": "HUMAN_REPLY",
      "to": "running"
    },
    {
      "from": "running",
      "event": "IMPLEMENTATION_RETURNED",
      "to": "freezing"
    },
    {
      "from": "running",
      "event": "NATIVE_FINISH_REQUESTED",
      "to": "freezing"
    },
    {
      "from": "freezing",
      "event": "CANDIDATE_FROZEN",
      "to": "verifying"
    },
    {
      "from": "verifying",
      "event": "CHECKS_PASSED",
      "to": "reviewing"
    },
    {
      "from": "verifying",
      "event": "CHECKS_FAILED",
      "to": "changes_required"
    },
    {
      "from": "reviewing",
      "event": "REVIEWS_PASSED",
      "to": "awaiting_approval"
    },
    {
      "from": "reviewing",
      "event": "REVIEWS_FAILED",
      "to": "changes_required"
    },
    {
      "from": "awaiting_approval",
      "event": "INTEGRATION_AUTHORIZED",
      "to": "integrating"
    },
    {
      "from": "integrating",
      "event": "INTEGRATION_CONFIRMED",
      "to": "integrated"
    },
    {
      "from": "awaiting_approval",
      "event": "CANDIDATE_INVALIDATED",
      "to": "changes_required"
    },
    {
      "from": "integrating",
      "event": "BASE_MOVED",
      "to": "changes_required"
    },
    {
      "from": "changes_required",
      "event": "REVISION_REQUESTED",
      "to": "ready"
    },
    {
      "from": "failed",
      "event": "RETRY_AUTHORIZED",
      "to": "ready"
    },
    {
      "from": "recovery_required",
      "event": "RECOVERY_RETRY_AUTHORIZED",
      "to": "ready"
    },
    {
      "from": "allocating",
      "event": "EXECUTION_UNCERTAIN",
      "to": "recovery_required"
    },
    {
      "from": "running",
      "event": "EXECUTION_UNCERTAIN",
      "to": "recovery_required"
    },
    {
      "from": "waiting_human",
      "event": "EXECUTION_UNCERTAIN",
      "to": "recovery_required"
    },
    {
      "from": "freezing",
      "event": "EXECUTION_UNCERTAIN",
      "to": "recovery_required"
    },
    {
      "from": "verifying",
      "event": "EXECUTION_UNCERTAIN",
      "to": "recovery_required"
    },
    {
      "from": "reviewing",
      "event": "EXECUTION_UNCERTAIN",
      "to": "recovery_required"
    },
    {
      "from": "integrating",
      "event": "EXECUTION_UNCERTAIN",
      "to": "recovery_required"
    },
    {
      "from": "allocating",
      "event": "EXECUTION_FAILED",
      "to": "failed"
    },
    {
      "from": "running",
      "event": "EXECUTION_FAILED",
      "to": "failed"
    },
    {
      "from": "waiting_human",
      "event": "EXECUTION_FAILED",
      "to": "failed"
    },
    {
      "from": "freezing",
      "event": "EXECUTION_FAILED",
      "to": "failed"
    },
    {
      "from": "verifying",
      "event": "EXECUTION_FAILED",
      "to": "failed"
    },
    {
      "from": "reviewing",
      "event": "EXECUTION_FAILED",
      "to": "failed"
    },
    {
      "from": "draft",
      "event": "CANCEL_CONFIRMED",
      "to": "cancelled"
    },
    {
      "from": "ready",
      "event": "CANCEL_CONFIRMED",
      "to": "cancelled"
    },
    {
      "from": "changes_required",
      "event": "CANCEL_CONFIRMED",
      "to": "cancelled"
    },
    {
      "from": "awaiting_approval",
      "event": "CANCEL_CONFIRMED",
      "to": "cancelled"
    },
    {
      "from": "failed",
      "event": "CANCEL_CONFIRMED",
      "to": "cancelled"
    },
    {
      "from": "allocating",
      "event": "CANCEL_QUIESCENT",
      "to": "cancelled"
    },
    {
      "from": "running",
      "event": "CANCEL_QUIESCENT",
      "to": "cancelled"
    },
    {
      "from": "waiting_human",
      "event": "CANCEL_QUIESCENT",
      "to": "cancelled"
    },
    {
      "from": "freezing",
      "event": "CANCEL_QUIESCENT",
      "to": "cancelled"
    },
    {
      "from": "verifying",
      "event": "CANCEL_QUIESCENT",
      "to": "cancelled"
    },
    {
      "from": "reviewing",
      "event": "CANCEL_QUIESCENT",
      "to": "cancelled"
    },
    {
      "from": "recovery_required",
      "event": "CANCEL_QUIESCENT",
      "to": "cancelled"
    }
  ],
  "notes": "Guards in spec/01-state-and-storage.md are mandatory. A row alone does not authorize a transition."
}
```

## A. task-spec.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/task-spec.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "objective": {
      "type": "string",
      "minLength": 1,
      "maxLength": 20000
    },
    "scope": {
      "type": "object",
      "properties": {
        "allowedPaths": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1024
          },
          "minItems": 1
        },
        "forbiddenPaths": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1024
          },
          "minItems": 0
        },
        "outOfScope": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          },
          "minItems": 0
        }
      },
      "required": [
        "allowedPaths",
        "forbiddenPaths",
        "outOfScope"
      ],
      "additionalProperties": false
    },
    "requirements": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^R[0-9]{3}$"
          },
          "requirement": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000
          },
          "verification": {
            "type": "string",
            "enum": [
              "check",
              "review",
              "human"
            ]
          },
          "checkIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 80
            },
            "minItems": 0
          }
        },
        "required": [
          "id",
          "requirement",
          "verification",
          "checkIds"
        ],
        "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 200
    },
    "contextFiles": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "minItems": 0,
      "maxItems": 200
    },
    "dependsOn": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z]+_[0-9a-f]{32}$"
      },
      "minItems": 0,
      "maxItems": 20
    },
    "risk": {
      "type": "string",
      "enum": [
        "low",
        "standard",
        "high"
      ]
    },
    "implementerProfile": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "reviewerProfiles": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "minItems": 1,
      "maxItems": 5
    },
    "checkIds": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "minItems": 1,
      "maxItems": 100
    },
    "interaction": {
      "type": "string",
      "enum": [
        "managed",
        "native"
      ]
    },
    "budget": {
      "type": "object",
      "properties": {
        "maxAttempts": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        },
        "maxRepairCycles": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10
        },
        "wallTimeSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 86400
        },
        "outputTokenLimit": {
          "type": "integer",
          "minimum": 1000,
          "maximum": 10000000
        },
        "costLimitMicros": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "maxAttempts",
        "maxRepairCycles",
        "wallTimeSeconds",
        "outputTokenLimit",
        "costLimitMicros"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "schemaVersion",
    "title",
    "objective",
    "scope",
    "requirements",
    "contextFiles",
    "dependsOn",
    "risk",
    "implementerProfile",
    "reviewerProfiles",
    "checkIds",
    "interaction",
    "budget"
  ],
  "additionalProperties": false
}
```

## A. worker-event.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-workbench.invalid/contracts/worker-event.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "attemptId": {
      "type": "string",
      "pattern": "^[a-z]+_[0-9a-f]{32}$"
    },
    "sourceSeq": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "workerInstanceId": {
      "type": "string",
      "pattern": "^[a-z]+_[0-9a-f]{32}$"
    },
    "occurredAtMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "type": {
      "type": "string",
      "enum": [
        "worker.ready",
        "run.started",
        "message.delta",
        "message.completed",
        "tool.started",
        "tool.completed",
        "input.requested",
        "usage.updated",
        "run.completed",
        "run.failed",
        "run.cancelled",
        "heartbeat",
        "protocol.warning"
      ]
    },
    "data": {
      "type": "object"
    }
  },
  "required": [
    "schemaVersion",
    "attemptId",
    "sourceSeq",
    "workerInstanceId",
    "occurredAtMs",
    "type",
    "data"
  ],
  "additionalProperties": false
}
```


# 付録B. 検証済み形式の入力例

schema-validな設計例で、digest・ID・modelは実運用の値ではない。fakeを本番へ流用しない。

## B. task-spec.json

```json
{
  "schemaVersion": 1,
  "title": "add関数の加算バグを直す",
  "objective": "既知のfixtureでadd(2,3)が5になることを保証する。",
  "scope": {
    "allowedPaths": [
      "src/**",
      "test/**"
    ],
    "forbiddenPaths": [
      ".github/**",
      ".codex/**"
    ],
    "outOfScope": [
      "依存追加",
      "外部APIアクセス"
    ]
  },
  "requirements": [
    {
      "id": "R001",
      "requirement": "add(2,3)=5、add(-1,1)=0を満たす",
      "verification": "check",
      "checkIds": [
        "unit"
      ]
    },
    {
      "id": "R002",
      "requirement": "引数の意味とAPIを変更しない",
      "verification": "review",
      "checkIds": []
    }
  ],
  "contextFiles": [
    "src/add.js",
    "test/add.test.js"
  ],
  "dependsOn": [],
  "risk": "standard",
  "implementerProfile": "fake-coding",
  "reviewerProfiles": [
    "fake-review-a",
    "fake-review-b"
  ],
  "checkIds": [
    "unit"
  ],
  "interaction": "managed",
  "budget": {
    "maxAttempts": 5,
    "maxRepairCycles": 2,
    "wallTimeSeconds": 1800,
    "outputTokenLimit": 30000,
    "costLimitMicros": null
  }
}
```

## B. project-policy.json

```json
{
  "schemaVersion": 1,
  "sourceBaseRef": "refs/heads/main",
  "defaultInteraction": "managed",
  "presentation": "none",
  "checks": [
    {
      "id": "unit",
      "argv": [
        "node",
        "--test",
        "test/add.test.js"
      ],
      "cwd": ".",
      "required": true,
      "timeoutSeconds": 30,
      "maxOutputBytes": 1048576,
      "env": {
        "pass": [
          "PATH"
        ],
        "set": {}
      },
      "network": "deny",
      "allowHosts": [],
      "expectedArtifacts": [],
      "mutatesSource": false
    }
  ],
  "bootstrap": [],
  "review": {
    "minimumReviewers": 2,
    "minimumTrainingFamilies": 1,
    "blockSeverities": [
      "blocker",
      "high"
    ],
    "allowIncomplete": false,
    "maxRepairCycles": 2
  },
  "riskRules": [
    {
      "paths": [
        ".github/**",
        "package.json",
        "pnpm-lock.yaml"
      ],
      "risk": "high",
      "requiredCheckIds": [
        "unit"
      ],
      "minimumTrainingFamilies": 2
    }
  ],
  "egress": {
    "allowedProviders": [
      "fake"
    ],
    "allowedPathPatterns": [
      "src/**",
      "test/**"
    ],
    "deniedPathPatterns": [
      ".env",
      "**/.env",
      "**/*.pem"
    ],
    "maxBytesPerRequest": 524288
  },
  "integration": {
    "mode": "managed-ref",
    "requireHumanApproval": true,
    "approvalTtlSeconds": 1800,
    "publishEnabled": false
  },
  "isolation": "cooperative-local",
  "limits": {
    "maxActiveWriters": 2,
    "maxActiveReviews": 2,
    "maxActiveBoards": 1,
    "maxTaskDiskBytes": 1073741824,
    "maxLogBytes": 33554432,
    "allowNestedDelegation": false
  }
}
```

## B. model-profile.json

```json
{
  "driver": "fake",
  "providerId": "fake",
  "trainingFamily": "simulation",
  "modelId": "fake-v1",
  "reasoningEffort": null,
  "maxOutputTokens": 4000,
  "contextBytesLimit": 524288
}
```

## B. review-output.json

```json
{
  "schemaVersion": 1,
  "summary": "fixtureの範囲でAPIと加算処理を確認した。",
  "verdict": "pass",
  "findings": [],
  "coverage": [
    {
      "path": "src/add.js",
      "status": "complete",
      "reason": "変更された1行全体を確認"
    }
  ],
  "requirementCoverage": [
    {
      "requirementId": "R001",
      "status": "supported",
      "evidence": [
        {
          "kind": "file",
          "reference": "src/add.js",
          "digest": null,
          "startLine": 1,
          "endLine": 1,
          "explanation": "candidateの実装はa+bを返す。"
        }
      ]
    },
    {
      "requirementId": "R002",
      "status": "supported",
      "evidence": [
        {
          "kind": "file",
          "reference": "src/add.js",
          "digest": null,
          "startLine": 1,
          "endLine": 1,
          "explanation": "candidateの実装はa+bを返す。"
        }
      ]
    }
  ],
  "openQuestions": []
}
```

## B. board-charter.json

```json
{
  "schemaVersion": 1,
  "question": "fixtureの加算仕様をどのテストで固定するか。",
  "shape": "decide",
  "decisionUse": "追加テストの選択",
  "contextArtifacts": [
    "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  ],
  "seats": [
    {
      "seatId": "alpha",
      "profile": "fake-review-a"
    },
    {
      "seatId": "beta",
      "profile": "fake-review-b"
    }
  ],
  "minimumTrainingFamilies": 1,
  "minimumRounds": 2,
  "maximumRounds": 5,
  "roundDeadlineSeconds": 300,
  "maxOutputTokensPerSeatRound": 4000,
  "maxTotalOutputTokens": 60000,
  "failurePolicy": "stop",
  "factChecks": [
    {
      "id": "unit-evidence",
      "checkId": "unit"
    }
  ],
  "isolation": "cooperative-local"
}
```

## B. approval-binding.json

```json
{
  "schemaVersion": 1,
  "action": "integrate",
  "repoId": "rep_11111111111111111111111111111111",
  "taskId": "tsk_22222222222222222222222222222222",
  "candidateIdentityDigest": "sha256:7777777777777777777777777777777777777777777777777777777777777777",
  "evidenceDigest": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
  "targetRef": "refs/heads/aw/integration/rep_11111111111111111111111111111111",
  "expectedBaseSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expiresAtMs": 1794000000000,
  "nonce": "9999999999999999999999999999999999999999999999999999999999999999"
}
```


# 付録C. 実装開始と検証結果

## Codexへの実装指示

以下を、新しく作成する `agent-workbench` リポジトリのCodexセッションへ渡す。

---

添付されたAgent Workbench設計一式から、独立した新規ツールを実装してください。要件の正本は `DESIGN.md`、機械可読契約は `contracts/` です。以下を守ってR0→R1→R2の順に進めてください。

## 目的

普段のCodex + Herdrを維持したまま、独立作業環境、immutable candidate、独立レビュー、human approval gate、blind multi-model Board、目的指向handoffを提供するlocal-firstツールを作ります。PiやClaude Codeへの乗り換えは不要です。

## 初回に読むファイル

`README.md`、`DESIGN.md`、`contracts/ports.ts`、`contracts/001_initial.sql`、全JSON Schema、`spec/08-implementation-and-tests.md`、`verification/RESULTS.md`。

## 実行順序

1. 新規repo以外の既存業務repoを変更しない。git push、PR、外部サービスへの書込みは行わない。
2. Node/Git/pnpm/SQLiteを確認し、scaffoldとlockfileを確定する。付属scaffoldは補助であり、完成品ではない。
3. 各JSON schemaからTypeScript型を生成するか型整合testを用意する。外部wire typesと内部portを分離する。
4. R0-01〜R0-11を実装。fake providerと既知fixtureで実行する。参照testを通すだけで製品完成としない。
5. R1ではCodex/Herdrの実binaryからschemaをcaptureしてbridgeを実装する。未知method名、flag、enumは推測しない。
6. sandboxが検証できない場合は `SANDBOX_UNVERIFIED` で停止する。危険なflag・outside-sandbox methodへfallbackしない。
7. R1のmanaged end-to-end後、R2のnative・外部review・Board・handoffへ進む。
8. 全ての完成判定を仕様の受け入れtestと実測logに紐づける。

## 変更してはいけない設計上の境界

- task state、attempt state、Herdr画面状態は別。
- approvalはcandidate SHAだけでなくidentity/evidence/base/action/expiry/nonceに紐づく。
- source repoのdevelopを自動checkout/reset/mergeしない。managed refへCASで統合し、bundleをexportする。
- reviewはfresh session。実装者の会話をコピーしない。
- native CodexをApp Serverから二重制御しない。
- workerにprivileged control socketやhuman tokenを渡さない。
- Boardの同round投稿は全席sealedまで他席に公開しない。
- 同モデルの別sessionをcross-vendor検証と呼ばない。
- fake test結果で業務repoのgateを通さない。
- 不明なruntimeを成功扱いにせずrecovery_requiredとする。

## 許可が必要な操作

実アカウントを使うlive API、API key設定、追加providerへのコード送信、利用者の既存repoへの反映、GitHubへのpush/PRは、対応する人間の明示許可がある時だけ行ってください。認証情報をファイルへ転記したり、既存auth.jsonを抽出・複製しないでください。

## 進捗記録

各実装単位について `実装ファイル / 該当仕様節 / test ID / 実行コマンド / 結果 / 未検証` を `IMPLEMENTATION_STATUS.md` に保存します。未実装を成功returnするstubは禁止します。unsupportedは明示errorにしてください。

最終出力では、製品実装、設計参照test、製品test、contract test、live test、未検証を分けて報告してください。個人の既存作業や未commit変更は必ず保持してください。

---

この指示は実装開始用であり、機密データ送信・課金・GitHub書込みへの包括的な承認ではありません。


## 設計用参照testの実行結果

- 結果: **80件成功 / failures 0 / errors 0 / skipped 0**
- 実行環境: Python 3.13.5、SQLite 3.46.1、git version 2.47.3、Node v22.16.0
- 証拠: `test-output.txt`、`results.json`
- 実行コマンド: `python verification/check_design.py`
- 外部ネットワーク、モデル認証、Codex、Herdrは呼び出していない。

## 確認内容

11種類のJSON Schema自体・正常例・unknown property拒否、canonical digest、状態遷移表、approval predicate、Board barrier、SQL制約、実GitのSHA1/256 snapshot/CAS、fixture testの失敗→修正→成功、元sourceの未commit変更保持、bundle verifyを確認した。

`contracts/ports.ts` は `tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext` でも型検査済み。scaffoldの2つのJavaScript補助scriptは `node --check` で構文検査済みです。本体実装・scaffoldの依存解決やビルドを実施したという意味ではありません。

## この結果が示さないこと

製品TypeScript実装の完成、Codex/Herdr実機動作、OS sandboxの強制、Gemini実接続、WALの耐障害性は未検証。設計のT01〜T80受け入れtestとは別の参照suiteであり、件数が同じでも内容が全部実施済みという意味ではない。

この環境のNode/SQLite versionは製品要件の確認とは別である。製品にはNode>=24、SQLite>=3.51.3を要求し、production doctorで再確認する。参照suiteはin-memory SQLiteで論理制約を試験している。

## 再実行

PythonとGitとNodeを用意し、jsonschemaを導入する。例:

```bash
uv run --with jsonschema python verification/check_design.py
```

または隔離したPython仮想環境でjsonschemaをinstallしてから実行する。自分の既存repoやglobal Git設定は使わず、一時ディレクトリ内で実Gitを動かす。
