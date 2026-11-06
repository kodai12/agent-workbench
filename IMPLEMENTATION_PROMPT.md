# Codexへの実装指示

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
