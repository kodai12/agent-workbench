# 開発方針

- 要件の正本はDESIGN.md、契約の正本はcontractsです。仕様を小さく読み替えないでください。
- TypeScriptとNode.js 24以上、pnpmを使ってください。追加依存は設計の境界に従ってください。
- 出力、説明、新規コメントは日本語で書いてください。取り込んだ契約は原文を保持してください。
- 既存リポジトリ、認証情報、グローバル設定を変更しないでください。
- live API、追加provider送信、GitHubへのpushとPRは明示許可まで実行しないでください。
- fakeを実接続やsandbox検証済みと表示しないでください。不明な実行は成功にしないでください。
- Gitや外部コマンドへ文字列をシェル展開せず、argv配列で実行してください。
- ユーザーの元repositoryは読み取り専用にし、managed bare repositoryだけを更新してください。
- 進捗と証拠はIMPLEMENTATION_STATUS.mdへ記録してください。
- 検証はpnpm verifyを基本とし、liveは人間の許可がある場合だけ実行してください。
