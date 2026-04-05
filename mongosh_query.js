const allDbs = db.adminCommand({ listDatabases: 1 }).databases.map(d => d.name).filter(n => n.startsWith("pidrax"));

print("=== ALL PIDRAX DATABASES ===");
allDbs.forEach(n => print("  " + n));

for (const dbName of allDbs) {
  const currentDb = db.getSiblingDB(dbName);
  const colls = currentDb.getCollectionNames();
  print("\n========================================");
  print("DATABASE: " + dbName);
  print("========================================");
  print("Collections (" + colls.length + "):");
  colls.forEach(c => print("  - " + c));

  const runColls = colls.filter(c => c.toLowerCase().includes("run"));
  print("\nCollections containing 'run': " + JSON.stringify(runColls));

  for (const rc of runColls) {
    const found = currentDb.getCollection(rc).findOne({ run_id: { $regex: "b7b706e2" } });
    if (found) {
      print("\n*** FOUND run_id match in " + dbName + "." + rc + " ***");
      print("  run_id: " + found.run_id);
      print("  Full doc keys: " + Object.keys(found).join(", "));
      const fullRunId = found.run_id;

      print("\n--- GRAPH NODES for run_id: " + fullRunId + " in " + dbName + " ---");
      const nodes = currentDb.getCollection("kb2_graph_nodes").find({ run_id: fullRunId }).toArray();
      print("Total graph nodes: " + nodes.length);

      if (nodes.length === 0) {
        const sampleNode = currentDb.getCollection("kb2_graph_nodes").findOne();
        if (sampleNode) {
          print("  (Sample node keys: " + Object.keys(sampleNode).join(", ") + ")");
          print("  (Sample node run_id: " + sampleNode.run_id + ")");
        }
      }

      const byType = {};
      nodes.forEach(n => {
        const t = n.entity_type || n.type || "UNKNOWN";
        if (!byType[t]) byType[t] = [];
        byType[t].push(n);
      });

      const types = Object.keys(byType).sort();
      print("\nEntity types found: " + types.join(", "));

      for (const t of types) {
        const entities = byType[t];
        print("\n  ===== " + t + " (" + entities.length + " entities) =====");
        for (const e of entities) {
          print("    -------");
          print("    display_name: " + (e.display_name || e.name || "(none)"));
          print("    confidence: " + (e.confidence !== undefined ? e.confidence : "(none)"));
          const status = e.status || (e.attributes && e.attributes.status) || "(none)";
          const docLevel = e.documentation_level || (e.attributes && e.attributes.documentation_level) || "(none)";
          const recoverySrc = e._recovery_source || (e.attributes && e.attributes._recovery_source) || "(none)";
          print("    status: " + status);
          print("    documentation_level: " + docLevel);
          print("    _recovery_source: " + recoverySrc);

          let srefs = e.source_refs || e.source_ref || e.sources || [];
          if (!Array.isArray(srefs)) srefs = [srefs];
          if (srefs.length > 0) {
            const titles = srefs.map(s => {
              if (typeof s === "string") return s;
              return s.title || s.name || s.source_title || JSON.stringify(s);
            });
            print("    source_ref titles: " + titles.join("; "));
          } else {
            print("    source_ref titles: (none)");
          }
        }
      }

      print("\n\n--- PATTERN SEARCH across all " + nodes.length + " entities ---");
      const patterns = [
        "adoption chooser",
        "navigation",
        "layout convention",
        "shelter event",
        "color convention",
        "browse pattern",
        "toy donation",
        "Tim",
        "Matt"
      ];

      for (const pat of patterns) {
        const regex = new RegExp(pat, "i");
        const matches = nodes.filter(n => {
          const blob = JSON.stringify(n);
          return regex.test(blob);
        });
        print("\n  Pattern: \"" + pat + "\" => " + matches.length + " match(es)");
        matches.forEach(m => {
          print("    - [" + (m.entity_type || m.type || "?") + "] " + (m.display_name || m.name || "(unnamed)"));
        });
      }

      print("\n\n--- TOTALS PER TYPE ---");
      for (const t of types) {
        print("  " + t + ": " + byType[t].length);
      }
      print("  GRAND TOTAL: " + nodes.length);
    }
  }
}

print("\n=== DONE ===");
