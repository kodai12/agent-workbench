# 実装・検証状況

2026-11-06。開発途中。R0の製品経路を実装し、R1/R2の契約adapterとfixture経路を追加しています。設計全体を完成とは判定していません。

## 製品実装と対応仕様

| 実装ファイル | 該当仕様節 | test ID・検査 | 結果・未検証 |
|---|---|---|---|
| package.json、scripts/、src/cli/ | 14、R0-01 | CLI lifecycle、空suite拒否 | Node24/pnpm固定、build済み |
| contracts/、src/contracts/、src/domain/ | 4、5、8、15.5/15.6、R0-02/03 | T03/04/05/06/49/50/59〜70/77、生成JSON600ケース | schema・strict parser・reducer・gate・data契約を製品テスト |
| src/adapters/sqlite/、filesystem/ | 5、12、R0-04/11 | T07〜14/72/73/78、storage-recovery | WAL/FULL/FK、checksum、immutable artifact、backup/restore、GC計画。旧home退避後の再配置と旧home/source不変も製品テスト済み |
| src/daemon/ | 5.6/5.7、13、R0-05 | 認証・再接続・二重daemon・slow consumer・切断 | 接続由来actorとprivate socket、長いhome対応 |
| src/adapters/git/ | 7、R0-06/08/10、R2-07 | T22〜34/56〜58/80、clean/smudge/process | 実Git SHA1/256、dirty保持、filter非実行、host snapshot、CAS、bundle fsck |
| src/worker/、src/application/workbench.ts、fake/check-runner.ts | 5、7、8、R0-07〜11 | workbench、workbench-recovery、os-paths | 実worker→snapshot→固定Nodeテスト→fresh fake review→承認→CAS→bundle。実repoのfake拒否、並列再送、source不変 |
| src/generated/、protocol-lock.json、src/application/protocol.ts | 6、R1-01 | capture lock | Codex0.164.0/Herdr0.8.0の1072生成fileをhash照合。live互換未検証 |
| src/adapters/codex/ | 6、11、R1-02〜06 | protocol-codex、生成wire runtime検証 | transport/fresh session/steer/interrupt/最終出力検証をmock確認。厳格sandbox・実runnerは拒否 |
| src/adapters/herdr-tui/ | 6、R1-07、R2-01 | protocol-herdr | workspace/pane occupant/固定launcher/native consentをmock確認。実session未検証、taskとのnative接続未実装 |
| src/adapters/gemini/ | 6、11、R2-02/03 | provider-gemini | provider/path/bytes/秘密情報制限、schema、bounded retry、unknown costをmock確認。実送信未実施 |
| src/domain/board.ts、src/application/board-service.ts | 9、R2-04/05 | T59〜68、Board integration | 永続barrier/epoch/access grant、全round、少数意見、raw bytes/小数estimate、budget。実provider未接続 |
| src/domain/handoff.ts、src/application/handoff-service.ts | 10、R2-06 | T69/70、Handoff integration | fixture目的別packet・引用・cutoff、same-task bounded検索。実provider/native履歴未接続 |

## 実行記録

- `pnpm verify`：unit/integration115、contract38、chaos3、計156件成功、skip0、終了コード0。実行ログは[PRODUCT_TESTS.log](verification/PRODUCT_TESTS.log)。
- `node scripts/protocol-lock.mjs`：1072file一致、liveVerified=false。
- bundled SQLite：better-sqlite3@13.0.3の実DBで3.53.4を確認。
- source filter・export回帰：Git13件成功。sourceの設定にclean/smudge/process/外部diff/textconvがあってもhost markerを作らない。
- workbench復旧・scope保護追加：4件成功。改訂依存とprofile、孤立stageの復旧待ち、symlink parent拒否、未知fixture拒否。

## 未実装・未検証

- R1-03〜06の実worker/check/reviewの製品接続は未完成。捕捉SandboxPolicyはrestricted readを宣言できず、canary未実装・未実施。実repoのstart/checkは明示拒否します。
- R1-08/09：実Codex・Herdrを使うE2Eとcrash試験は未実施。課金・認証・専用sessionの明示許可がありません。
- R2-01：native adapterはmockで検証しましたが、task.start/finishとwriterのforeground/残存子process停止証明は未接続です。
- R2-03〜06：Gemini、Board、Handoffの実provider製品経路は未接続。外部送信は行っていません。
- R2-08：初期schemaと未知新schema拒否はテスト済み。過去リリースからのupgrade/migration全体とlive acceptanceは未成立です。
- T01〜T80は設計の分類です。全80条件を満たしたという意味ではありません。提供参照test本体は添付されておらず、verification/RESULTS.mdの80件を再実行した実績はありません。
- TTYの人間承認入力は未実施。非TTYでの拒否と、製品内部のbinding検証・期限・再送・統合はテストしています。
- pnpm test:liveにはlive suiteがなく、対象ゼロ件として失敗します。live試験を済ませた扱いにはしません。
- Git symlink/gitlink変更は初版では保守的に拒否します。NFS/SMB/同期ドライブは非対応です。
- push、PR作成、実リポジトリへの反映は実施していません。

独立レビューの修正と再確認は[REVIEW.md](docs/REVIEW.md)に記録しました。comments検査67file、tests検査24fileとも成功。plan-lint/plan-verify成功。ローカルbranchはfeat/workbench-foundation、remote未設定です。
