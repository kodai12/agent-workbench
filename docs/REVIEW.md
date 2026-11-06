# ローカル実装レビュー

2026-11-06。独立レビュアーの指摘を修正し、差分を再確認しました。

| 指摘 | 対応 | 検証 |
|---|---|---|
| sourceのgit statusが任意clean filterをhost実行 | index列挙とNodeのraw bytes比較へ変更 | clean/smudge/process/外部diff/textconv、dirty同サイズ変更 |
| task改訂で依存関係が旧版のまま | 作成・改訂の意味検証を共有、同transactionで依存同期 | 未統合依存、循環、未設定profile拒否 |
| daemon継続処理喪失後にtaskが取り残される | orphan stageをrecovery_required、commandをuncertainへ移す | 再起動時の状態と明示復旧・新generation |
| restoreが旧homeを参照 | managed path再配置、worktree metadata隔離、旧worker identity失効 | 旧home退避後の読取/export/checkout、旧home/source全bytes・mode・mtime不変 |
| export refがDB候補から移動できる | DBの候補SHA固定、中立bare、bundleと独立verifierのOID照合、検証後原子公開 | 事前ref変更、途中race、壊れたbundle、既存out不変 |
| provider event dataと正規化契約が不整合 | emit境界で必須fieldを揃え、全eventをvalidatorへ渡すtestを追加 | Codex/Gemini mock contract |

restoreとexportの修正後、独立レビュアーが再読・対象14件成功を確認しました。その後、復元済prepared integrationの自動再確定を禁止し、uncertainとして保留する回帰を追加しました。

過剰設計の点検では、旧check plan組立てとTask作成時の重複意味検証を削除しました。共通JSON値guardは循環依存を避けて一箇所へ集約しています。

未完成の実provider接続、native finish、sandbox canary、live E2Eはレビュー済み完成範囲に含めません。詳細はIMPLEMENTATION_STATUS.mdを参照してください。
