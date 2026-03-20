const db = connect("mongodb://localhost:27017/pidrax_pawfinder2");
const runId = "b7b706e2-2eb0-4b83-bd2b-a745659194dc";
const col = db.getCollection("kb2_graph_nodes");

function excerpt(text, maxLen) {
  if (!text) return "(none)";
  let s = String(text);
  return s.length > maxLen ? s.substring(0, maxLen) + "..." : s;
}

function printEntity(e, opts) {
  opts = opts || {};
  let maxExcerpt = opts.maxExcerpt || 150;
  print("  -- display_name: " + e.display_name);
  if (!opts.skipType) print("     type: " + e.type);
  if (!opts.skipConfidence) print("     confidence: " + (e.confidence !== undefined ? e.confidence : "(n/a)"));
  if (opts.showProcessStatus) {
    let attrs = e.attributes || {};
    print("     process_status: " + (attrs.process_status || "(n/a)"));
    print("     documentation_level: " + (attrs.documentation_level || "(n/a)"));
  }
  if (!opts.skipAttributes) {
    let attrs = e.attributes || {};
    let keys = Object.keys(attrs);
    if (keys.length > 0) {
      print("     attributes:");
      keys.forEach(function(k) {
        let v = attrs[k];
        if (Array.isArray(v)) v = JSON.stringify(v);
        else if (typeof v === "object" && v !== null) v = JSON.stringify(v);
        print("       " + k + ": " + v);
      });
    } else {
      print("     attributes: (none)");
    }
  }
  let refs = e.source_refs || [];
  if (refs.length > 0) {
    print("     source_refs (" + refs.length + "):");
    refs.forEach(function(r, i) {
      print("       [" + i + "] title: " + (r.title || "(none)"));
      print("           excerpt: " + excerpt(r.excerpt, maxExcerpt));
    });
  } else {
    print("     source_refs: (none)");
  }
  print("");
}

function searchByTerms(label, terms, typeFilter) {
  print("==========================================================");
  print("SEARCH: " + label);
  print("==========================================================");
  let orConditions = [];
  terms.forEach(function(t) {
    let re = { $regex: t, $options: "i" };
    let conds = [
      { display_name: re },
      { aliases: re },
      { "source_refs.excerpt": re },
      { "source_refs.title": re }
    ];
    orConditions = orConditions.concat(conds);
  });
  let query = { run_id: runId, $or: orConditions };
  if (typeFilter) {
    if (Array.isArray(typeFilter)) {
      query.type = { $in: typeFilter };
    } else {
      query.type = typeFilter;
    }
  }
  let results = col.find(query).toArray();
  print("Found " + results.length + " entities\n");
  results.forEach(function(e) { printEntity(e); });
}

searchByTerms(
  '1) "adoption chooser" OR "pet chooser" OR "PAW-8"',
  ["adoption chooser", "pet chooser", "PAW-8"]
);

searchByTerms(
  '2) "shelter event" OR "PAW-34"',
  ["shelter event", "PAW-34"]
);

searchByTerms(
  '3) "navigation improvement" OR "PAW-18" OR "site navigation"',
  ["navigation improvement", "PAW-18", "site navigation"]
);

searchByTerms(
  '4) Decisions mentioning "color" OR "pink" OR "blue" OR "accent" OR "green button"',
  ["color", "pink", "blue", "accent", "green button"],
  "decision"
);

searchByTerms(
  '5) Decisions mentioning "sidebar" OR "left nav" OR "vertical" OR "horizontal column" OR "layout"',
  ["sidebar", "left nav", "vertical", "horizontal column", "layout"],
  "decision"
);

searchByTerms(
  '6) Decisions/Processes mentioning "client-side" OR "load all" OR "round-trip" OR "no reason to" OR "load them all"',
  ["client-side", "load all", "round-trip", "no reason to", "load them all"],
  ["decision", "process"]
);

searchByTerms(
  '7) "toy" OR "donating"',
  ["toy", "donating"]
);

print("==========================================================");
print("SEARCH 8: All entities of type 'decision'");
print("==========================================================");
let decisions = col.find({ run_id: runId, type: "decision" }).toArray();
print("Found " + decisions.length + " decision entities\n");
decisions.forEach(function(e) {
  let firstExcerpt = "(none)";
  if (e.source_refs && e.source_refs.length > 0 && e.source_refs[0].excerpt) {
    firstExcerpt = excerpt(e.source_refs[0].excerpt, 100);
  }
  print("  -- " + e.display_name);
  print("     first excerpt: " + firstExcerpt);
  print("");
});

print("==========================================================");
print("SEARCH 9: All entities of type 'process'");
print("==========================================================");
let processes = col.find({ run_id: runId, type: "process" }).toArray();
print("Found " + processes.length + " process entities\n");
processes.forEach(function(e) {
  let attrs = e.attributes || {};
  let firstExcerpt = "(none)";
  if (e.source_refs && e.source_refs.length > 0 && e.source_refs[0].excerpt) {
    firstExcerpt = excerpt(e.source_refs[0].excerpt, 100);
  }
  print("  -- " + e.display_name);
  print("     process_status: " + (attrs.process_status || "(n/a)"));
  print("     documentation_level: " + (attrs.documentation_level || "(n/a)"));
  print("     first excerpt: " + firstExcerpt);
  print("");
});

print("=== DONE ===");
