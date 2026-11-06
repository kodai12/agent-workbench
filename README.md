# Agent Workbench

CodexとHerdr向けの、ローカルで動くTypeScriptツールです。現在は開発途中です。既知fixtureの実装・検証・レビュー・承認・Git統合を実行でき、実モデルの実行は安全性の確認が済むまで拒否します。

[実装状況](IMPLEMENTATION_STATUS.md)と[設計書](DESIGN.md)に、対応範囲と未検証事項を記録しています。

## セットアップ

Node.js 24以上、Git、pnpm 12.14.0を使います。dotfilesやNixへの依存はありません。

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli/main.js --version
pnpm verify
```

依存のbuild scriptは`better-sqlite3@13.0.3`だけ許可しています。bundled SQLiteは起動時に3.51.3以上であることを検査します。

## オフラインで試す

日常用homeと分けた空のディレクトリを指定します。以下の`$AW_DEMO_HOME`は、試験専用の絶対パスに設定してください。

```bash
node dist/src/cli/main.js --home "$AW_DEMO_HOME" init --dev-fixtures
node dist/src/cli/main.js --home "$AW_DEMO_HOME" doctor --offline --json
node dist/src/cli/main.js --home "$AW_DEMO_HOME" daemon start
node dist/src/cli/main.js --home "$AW_DEMO_HOME" repo add "$AW_DEMO_HOME/fixtures/demo" --name demo --base-ref refs/heads/main
node dist/src/cli/main.js --home "$AW_DEMO_HOME" policy import --repo demo --file examples/project-policy.json
node dist/src/cli/main.js --home "$AW_DEMO_HOME" policy trust --repo demo
node dist/src/cli/main.js --home "$AW_DEMO_HOME" task create --repo demo --spec examples/task-spec.json
```

`policy trust`は、表示したpolicy全文とdigestを人間の端末で確認します。返されたtask IDを次の`TASK_ID`へ指定します。

```bash
node dist/src/cli/main.js --home "$AW_DEMO_HOME" task start TASK_ID
node dist/src/cli/main.js --home "$AW_DEMO_HOME" task status TASK_ID
node dist/src/cli/main.js --home "$AW_DEMO_HOME" task logs TASK_ID
node dist/src/cli/main.js --home "$AW_DEMO_HOME" approval request --task TASK_ID --action integrate
node dist/src/cli/main.js --home "$AW_DEMO_HOME" approval inspect REQUEST_ID
node dist/src/cli/main.js --home "$AW_DEMO_HOME" approval grant REQUEST_ID
node dist/src/cli/main.js --home "$AW_DEMO_HOME" task integrate TASK_ID --approval APPROVAL_ID
node dist/src/cli/main.js --home "$AW_DEMO_HOME" task export TASK_ID --format git-bundle --out "$AW_DEMO_HOME/exports/result.bundle"
node dist/src/cli/main.js --home "$AW_DEMO_HOME" daemon stop
```

承認と統合では、表示したbindingのdigestをTTYへ入力します。`--json`でもこの確認を省略できません。管理用bare repositoryのrefだけを更新し、元のcheckoutやbranchには反映しません。bundleの元リポジトリへの取り込みは利用者が行います。

fakeは`init --dev-fixtures`が作った既知sourceに限定されます。fake checkは固定したNodeテストの実プロセスを起動しますが、その結果は`simulated=true`です。実リポジトリの承認には使えません。

## 調査・復旧

`task logs --follow`は保存済みseqから購読できます。通信が切れたら`--after-seq N`で再購読します。再送には同じ`--request-id req_<32桁の16進数>`を使い、内容とactorが一致する場合だけ既存結果を返します。更新は`--expected-version N`を指定でき、省略時は直前に現在版を取得します。

`task cancel`は停止要求を送り、終了を確認してからcancelledへ移します。停止や継続処理を確定できない場合は`recovery_required`を保持します。`task recover`の計画digestを確認して再試行します。daemon停止はworker停止を意味しません。

```bash
node dist/src/cli/main.js --home "$AW_DEMO_HOME" backup --destination /absolute/path/to/new-backup
node dist/src/cli/main.js --home "$AW_DEMO_HOME" gc --plan
node dist/src/cli/main.js --home "$AW_DEMO_HOME" daemon recover-lock
```

backupは既存出力先を上書きしません。資格情報・control token・worker spool・checkoutは含めません。復元は`backup restore --source BACKUP --destination NEW_HOME`で新規homeに限定し、承認を失効させ、tokenを再生成します。旧workerを自動再起動しません。GCは候補の表示だけです。NFS・SMB・同期ドライブ上のhomeは対応範囲外です。

## Codex・Herdrの契約

捕捉済みwireは`src/generated/`、版・binary hash・生成物hashは`protocol-lock.json`です。生成型と内部portを分けています。

```bash
codex app-server generate-ts --out src/generated/codex
codex app-server generate-json-schema --out src/generated/codex-json
herdr api schema --output src/generated/herdr/schema.json
node scripts/normalize-generated.mjs
node scripts/protocol-lock.mjs --record --codex /absolute/path/to/codex --herdr /absolute/path/to/herdr
node scripts/protocol-lock.mjs
pnpm verify
```

この更新手順は実行許可の付与ではありません。型・mock contractが通っても、live接続・課金・隔離の成立は証明しません。実行するbinaryと生成物の互換性確認、専用Codex homeでの公式login、試験用Herdr session、sandbox canary、実モデルE2Eは別途必要です。既存の`auth.json`を抽出・複製しないでください。

現在捕捉したCodex 0.164.0のSandboxPolicyにはrestricted readを指定する契約がありません。厳格sandboxと実check runnerは`SANDBOX_UNVERIFIED`で拒否します。Herdr 0.8.0のCLI契約をmockで確認していますが、PATH上のHerdrが別版なら、その版で対応しているとは扱いません。

## Board・Handoff

fixture homeでは`board create --file examples/board-charter.json`、`board start BOARD_ID`、`board status BOARD_ID`、`board memo BOARD_ID`を使えます。現roundの投稿は全席がsealedになるまで公開しません。epoch、席ごとの公開許可、異論、未確認前提を保存します。fakeの複数席は実モデルによる独立検証を意味しません。

`handoff create --task TASK_ID --goal TEXT`は参照digestとcutoffを固定します。`history query --task TASK_ID --question TEXT`は同taskの保存履歴を上限付きで検索します。現在の製品経路はfixture用で、実providerへの送信とnative会話の取得は未接続です。

## 検証の区別

`pnpm verify`はunit/integration、contract、chaosを実行し、対象ゼロ件を失敗にします。通常検査は課金APIを呼びません。`verification/RESULTS.md`は提供資料の参照結果であり、本実装の実行記録ではありません。実モデル・実Herdr session・sandbox canary・TTYでの実承認入力は未検証です。詳細と再実行コマンドはIMPLEMENTATION_STATUS.mdに記載しています。
