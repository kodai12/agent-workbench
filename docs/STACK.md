# stacked PRのレビュー順

先頭から順にレビューする35段のDraft PRです。各PRのbaseは直前段のbranchです。前段の差分は、そのPRの差分へ含まれません。

通常の手書き差分は約100〜551行です。提供資料の取り込み（第2段）と機械生成capture（第19段）は独立しています。生成物とlockはGitHubで既定折り畳みにしています。

| 順番 | PR | 内容 | 手書き等の差分行数 | 生成物の差分行数 | 当段のテスト件数 |
|---|---|---|---:|---:|---:|
| 01 | [#2](https://github.com/kodai12/agent-workbench/pull/2) | NodeとTypeScriptの実行基盤を追加 | 274 | 476 | — |
| 02 | [#3](https://github.com/kodai12/agent-workbench/pull/3) | 提供された設計資料を取り込む | 5803（提供原文） | 6722 | — |
| 03 | [#4](https://github.com/kodai12/agent-workbench/pull/4) | 初期DBスキーマを追加 | 362 | 0 | — |
| 04 | [#5](https://github.com/kodai12/agent-workbench/pull/5) | タスク仕様を追加 | 278 | 0 | — |
| 05 | [#6](https://github.com/kodai12/agent-workbench/pull/6) | プロジェクト方針を追加 | 504 | 0 | — |
| 06 | [#7](https://github.com/kodai12/agent-workbench/pull/7) | 実行と承認の契約を追加 | 380 | 0 | — |
| 07 | [#8](https://github.com/kodai12/agent-workbench/pull/8) | レビュー出力の契約を追加 | 414 | 0 | — |
| 08 | [#9](https://github.com/kodai12/agent-workbench/pull/9) | Boardの募集条件を追加 | 182 | 0 | — |
| 09 | [#10](https://github.com/kodai12/agent-workbench/pull/10) | Board投稿の契約を追加 | 551 | 0 | — |
| 10 | [#11](https://github.com/kodai12/agent-workbench/pull/11) | 引き継ぎと状態遷移の契約を追加 | 538 | 0 | — |
| 11 | [#12](https://github.com/kodai12/agent-workbench/pull/12) | 厳格JSONと契約の読込を追加 | 290 | 0 | 25 |
| 12 | [#13](https://github.com/kodai12/agent-workbench/pull/13) | タスク遷移と検証ゲートを追加 | 316 | 0 | 66 |
| 13 | [#14](https://github.com/kodai12/agent-workbench/pull/14) | Board公開と引用の判定を追加 | 111 | 0 | 75 |
| 14 | [#15](https://github.com/kodai12/agent-workbench/pull/15) | 安全なパスと永続ファイルを追加 | 242 | 0 | 75 |
| 15 | [#16](https://github.com/kodai12/agent-workbench/pull/16) | 独立homeと既知fixtureを追加 | 142 | 0 | 75 |
| 16 | [#17](https://github.com/kodai12/agent-workbench/pull/17) | SQLiteとバックアップを追加 | 468 | 0 | 86 |
| 17 | [#18](https://github.com/kodai12/agent-workbench/pull/18) | 元repoを保持した候補と統合を追加 | 330 | 0 | 99 |
| 18 | [#19](https://github.com/kodai12/agent-workbench/pull/19) | 認証済みIPCと復旧を追加 | 340 | 0 | 109 |
| 19 | [#20](https://github.com/kodai12/agent-workbench/pull/20) | 生成wireと捕捉結果を固定 | 102 | 168553 | 110 |
| 20 | [#21](https://github.com/kodai12/agent-workbench/pull/21) | transportとfresh sessionの契約を追加 | 246 | 0 | 117 |
| 21 | [#22](https://github.com/kodai12/agent-workbench/pull/22) | 管理paneの操作契約を追加 | 116 | 0 | 123 |
| 22 | [#23](https://github.com/kodai12/agent-workbench/pull/23) | 送信制限と構造化出力を追加 | 163 | 0 | 135 |
| 23 | [#24](https://github.com/kodai12/agent-workbench/pull/24) | roundと席ごとの公開を永続化 | 163 | 0 | 143 |
| 24 | [#25](https://github.com/kodai12/agent-workbench/pull/25) | 引用付き引き継ぎと履歴を追加 | 100 | 0 | 146 |
| 25 | [#26](https://github.com/kodai12/agent-workbench/pull/26) | 既知fixtureの実行と制御を追加 | 540 | 0 | 148 |
| 26 | [#27](https://github.com/kodai12/agent-workbench/pull/27) | 保存領域と構成の基盤を接続 | 419 | 0 | 148 |
| 27 | [#28](https://github.com/kodai12/agent-workbench/pull/28) | repo登録とタスク仕様を接続 | 399 | 0 | 148 |
| 28 | [#29](https://github.com/kodai12/agent-workbench/pull/29) | workerとspoolの観測を接続 | 321 | 0 | 148 |
| 29 | [#30](https://github.com/kodai12/agent-workbench/pull/30) | 候補凍結と固定checkを接続 | 245 | 0 | 148 |
| 30 | [#31](https://github.com/kodai12/agent-workbench/pull/31) | 独立レビューとgateを接続 | 336 | 0 | 148 |
| 31 | [#32](https://github.com/kodai12/agent-workbench/pull/32) | 承認と候補SHA固定の統合を接続 | 391 | 0 | 148 |
| 32 | [#33](https://github.com/kodai12/agent-workbench/pull/33) | 停止と起動時の復旧を接続 | 508 | 0 | 150 |
| 33 | [#34](https://github.com/kodai12/agent-workbench/pull/34) | fixtureの全経路を接続 | 223 | 0 | 153 |
| 34 | [#35](https://github.com/kodai12/agent-workbench/pull/35) | 操作コマンドとdaemon起動を追加 | 231 | 0 | 156 |
| 35 | [#1](https://github.com/kodai12/agent-workbench/pull/1) | 利用手順と検証記録を追加 | 153（本案内を除く） | 191 | 156 |

## 検証

- 第1〜10段: 型検査・build。テスト追加前のためテスト合格件数には未算入。
- 第11〜15段: 型検査・buildと、その段に存在するunit/integration・contract test。
- 第16〜35段: 各段でpnpm verifyを実行。最終段は156件成功、skip 0件。
- 分割前の1178ファイルについてblobとmodeの一致を確認。製品コードの最終内容は分割前と同一。追加は生成物の表示属性とこの案内のみ。
- 第26〜32段は統合処理の段階追加。未接続操作は明示拒否し、fixture全経路は第33段で接続。
- 実provider・native・sandbox canary等の未完成項目は[実装状況](../IMPLEMENTATION_STATUS.md)を参照。

## マージ時の扱い

この作業ではマージしていません。先頭から順に扱い、前段をsquash mergeする場合は後続branchの基点を更新してから次へ進めてください。
