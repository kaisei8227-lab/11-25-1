# Gothic Duel 差し替えファイル一式

## 置き場所（Eclipse プロジェクト）
| このフォルダ | プロジェクト内の場所 |
|---|---|
| static/*.html, static/css, static/js | src/main/resources/static/ （同じ名前のファイルは上書き） |
| java/model/*.java | src/main/java/com/example/cardgame/model/ |
| java/controller/*.java | src/main/java/com/example/cardgame/controller/ |
| java/service/*.java | src/main/java/com/example/cardgame/service/ |
| test-tools/CardsJsGenerator.java | src/test/java/com/example/cardgame/tools/ （cards.csv → cards.js を作り直す時だけ実行） |

build.gradle の dependencies に次の1行が必要（パスワードのハッシュ化）:
    implementation 'org.springframework.security:spring-security-crypto'

## 削除してよいファイル（どこからも使われていない）
- static: index.html, app.js, game.js, style.css, gothic.css, js/card-data.js
- java: GameController.java, model/GameRoom.java, model/Player.java

## 新しく増えたもの
- UserController（/api/users/{id}, /progress, /name）… 進行データをサーバーに保存、名前変更
- User に mp・progress 列（JPA の ddl-auto=update なら自動で列が追加されます）
- js/sync.js … localStorage の変更を自動でサーバーに保存
- js/missions.js, js/card-view.js, css/card.css

## グループ判定
直近10試合（対人戦のみ、CPU戦は数えない）の勝ち数 ÷ 10 で判定し、1段階ずつ昇格。下がらない。
エメラルド→トパーズ 20%／→ルビー 40%／→サファイア 60%／→ダイヤモンド 80%
