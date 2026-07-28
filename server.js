const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { exiftool } = require("exiftool-vendored");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use("/Photos", express.static("Photos"));

if (!fs.existsSync("Photos")) {
    fs.mkdirSync("Photos");
}

// ---------- DATABASE SETUP ----------
const db = new Database("database.db");

db.exec(`
CREATE TABLE IF NOT EXISTS profilephotos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    personid INTEGER UNIQUE
);
CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT,
    last_name TEXT,
    birthdate DATE,
    deathdate DATE,
    Profession TEXT
);
CREATE TABLE IF NOT EXISTS relations (
    personId INTEGER NOT NULL,
    relatedId INTEGER NOT NULL,
    relation_type TEXT NOT NULL,
    PRIMARY KEY (personId, relatedId)
);
INSERT OR IGNORE INTO people (id, first_name) VALUES (1, 'Unknown');
`);


// ---------- FILE UPLOAD ----------
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "Photos/"),
    filename: (req, file, cb) => {
        const unique = Date.now() + "-" + file.originalname;
        cb(null, unique);
    }
});

const upload = multer({ storage });

app.post("/photoupload", upload.single("photos"), (req, res) => {
    try {
        const filename = req.file.filename;
        const personid = req.body.personid;

        // 1. Check for existing photo
        const existing = db.prepare(`
            SELECT filename FROM profilephotos
            WHERE personid = ?
        `).get(personid);

        // 2. Delete old file if it exists
        if (existing && existing.filename) {
            const oldPath = path.join(__dirname, "Photos", existing.filename);

            if (fs.existsSync(oldPath)) {
                fs.unlinkSync(oldPath);
            }
        }

        // 3. Replace DB entry
        db.prepare(`
            INSERT INTO profilephotos (filename, personid)
            VALUES (?, ?)
            ON CONFLICT(personid) DO UPDATE SET filename = excluded.filename
        `).run(filename, personid);

        res.json({ success: true });

    } catch (err) {
        console.error("Upload route failed:", err);
        res.status(500).json({ error: "Upload failed" });
    }
});

function AlreadyExists(relatedId, relation_type) {
    relatives = db.prepare("SELECT count(*) as count FROM relations WHERE relatedId = ? AND relation_type = ?").all(relatedId, relation_type);
    if(relation_type == "Parent"){
        if(relatives[0].count >= 2) return true;
        else return false;
    }
    if(relation_type == "Partner"){
        if(relatives[0].count >= 1) return true;
        else return false;
    }
    return false;
}

function relate(personId, relatedId, relation_type) {
    db.prepare("INSERT INTO relations (personId, relatedId, relation_type) VALUES (?, ?, ?)")
    .run(personId, relatedId, relation_type);
    if (relation_type == "Parent") {
        db.prepare("INSERT INTO relations (personId, relatedId, relation_type) VALUES (?, ?, ?)")
        .run(relatedId, personId, "Child");
    } else if (relation_type == "Child") {
        db.prepare("INSERT INTO relations (personId, relatedId, relation_type) VALUES (?, ?, ?)")
        .run(relatedId, personId, "Parent");
    } else {
        db.prepare("INSERT INTO relations (personId, relatedId, relation_type) VALUES (?, ?, ?)")
        .run(relatedId, personId, relation_type);
    }
}

function update_shared_relations(newPersonId, relatedId, relation_type) {
    if (relation_type == "Parent") {
        const other_children = db.prepare("SELECT personId FROM relations WHERE relatedId = ? AND personId != ? AND relation_type = 'Sibling'").all(relatedId, newPersonId);
        other_children.forEach(child => {
            relate(newPersonId, child.personId, "Parent");
        });
        other_parents = db.prepare("SELECT personId FROM relations WHERE relatedId = ? AND personId != ? AND relation_type = 'Parent'").all(relatedId, newPersonId);
        other_parents.forEach(parent => {
            relate(newPersonId, parent.personId, "Partner");
        });
    } else if (relation_type == "Child") {
        const other_children = db.prepare("SELECT personId FROM relations WHERE relatedId = ? AND personId != ? AND relation_type = 'Child'").all(relatedId, newPersonId);
        other_children.forEach(child => {
            relate(newPersonId, child.personId, "Sibling");
        });
        const other_parents = db.prepare("SELECT personId FROM relations WHERE relatedId = ? AND personId != ? AND relation_type = 'Partner'").all(relatedId, newPersonId);
        other_parents.forEach(parent => {
            relate(newPersonId, parent.personId, "Child");
        });
    } else if (relation_type == "Partner") {
        const children = db.prepare("SELECT personId FROM relations WHERE relatedId = ? AND personId != ? AND relation_type = 'Child'").all(relatedId, newPersonId);
        children.forEach(child => {
            relate(newPersonId, child.personId, "Parent");
        });
    } else if (relation_type == "Sibling") {
        const parents = db.prepare("SELECT personId FROM relations WHERE relatedId = ? AND personId != ? AND relation_type = 'Parent'").all(relatedId, newPersonId);
        parents.forEach(parent => {
            relate(newPersonId, parent.personId, "Child");
        });    
        const siblings = db.prepare("SELECT personId FROM relations WHERE relatedId = ? AND personId != ? AND relation_type = 'Sibling'").all(relatedId, newPersonId);
        siblings.forEach(sibling => {
            relate(newPersonId, sibling.personId, "Sibling");
        });
    }
}
    // ---------- PEOPLE UPLOAD ROUTE ----------
app.post("/createPerson", (req, res) => {
    if (AlreadyExists(req.body.relatedId, req.body.relation_type)) {
        return res.status(409).json({ error: "Already exists" });
    }
    const newperson = db.prepare("INSERT INTO people (first_name, last_name) VALUES (?, ?)").run("Unknown", "Unknown");
    relate(newperson.lastInsertRowid, req.body.relatedId, req.body.relation_type);
    update_shared_relations(newperson.lastInsertRowid, req.body.relatedId, req.body.relation_type);
    res.json({ id: newperson.lastInsertRowid});
});
app.patch("/updatePerson/:id", (req, res) => {
    db.prepare(`UPDATE people SET first_name = ?, last_name = ?, birthdate = ?, deathdate = ?, profession = ?
            WHERE id = ?`).run(req.body.first_name, req.body.last_name, req.body.birthdate, req.body.deathdate, req.body.profession, req.params.id);
    res.json({ success: true });
});

app.get("/keynode/:id", (req, res) => {
    const relations = db.prepare("SELECT relation_type FROM relations WHERE personId = ?").all(req.params.id);
    if (relations.some(r => r.relation_type === "Parent")) {
        if(relations.some(r => r.relation_type === "Child") || relations.some(r => r.relation_type === "Sibling")) {
            res.json({ isKeyNode: true });
        }
    } else {
        res.json({ isKeyNode: false });
    }
});

app.delete("/deletePerson/:id", (req, res) => {
    if (req.params.id == 1) {
        return res.status(400).json({ error: "Cannot delete this person." });
    }
    db.prepare("DELETE FROM relations WHERE personId = ? OR relatedId = ?").run(req.params.id, req.params.id);
    db.prepare("DELETE FROM people WHERE id = ?").run(req.params.id);
    db.prepare("DELETE FROM profilephotos WHERE personid = ?").run(req.params.id);
    res.json({ success: true });
});

// ---------- GET ALL PHOTOS ----------
app.get("/person/:id", (req, res) => {
    const person = db.prepare(`
        SELECT * FROM people
        WHERE id = ?
    `).get(req.params.id);
    if (!person) {
        return res.status(404).json({ error: "Person not found" });
    }
    res.json(person);
});
app.get("/relatedpeople/:id", (req, res) => {
    const people = db.prepare(`
        SELECT personId, relation_type FROM relations
        WHERE relations.relatedId = ?
    `).all(req.params.id);
    res.json(people);
});
app.get("/grandparents/:id", (req, res) => {
    const grandparents = db.prepare(`
        SELECT r1.personId as grandparentId 
        FROM relations r1 JOIN relations r2 
        ON r1.relatedId = r2.personId
        WHERE r2.relatedId = ? AND r1.relation_type = 'Parent' AND r2.relation_type = 'Parent'
    `).all(req.params.id);
    res.json(grandparents);
});
app.get("/grandchildren/:id", (req, res) => {
    const grandchildren = db.prepare(`
        SELECT r1.personId as grandchildId 
        FROM relations r1 JOIN relations r2 
        ON r1.relatedId = r2.personId
        WHERE r2.relatedId = ? AND r1.relation_type = 'Child' AND r2.relation_type = 'Child'
    `).all(req.params.id);
    res.json(grandchildren);
});
app.get("/picture/:id", (req, res) => {
    let picture = db.prepare(`
        SELECT * FROM profilephotos
        WHERE personid = ?
    `).get(req.params.id);
    if (!picture) {
        picture = {
            id: 0,
            filename: "ghost.png",
            description: null,
            personid: null,
            fileHash: null
        };
    }
    res.json(picture);
});
const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Running on http://localhost:${PORT}`);
});