# 設計用参照testの実行結果

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
