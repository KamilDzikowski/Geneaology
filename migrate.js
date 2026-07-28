const Database = require("better-sqlite3");
const db = new Database("database.db");
try {
    db.exec("ALTER TABLE people ADD COLUMN profession TEXT;");
    console.log("Migration successful");
} catch (e) {
    console.log(e.message);
    throw e;
}
db.close();