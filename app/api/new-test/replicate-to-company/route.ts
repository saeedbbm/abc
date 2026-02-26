import { NextRequest } from "next/server";
import { db } from "@/lib/mongodb";
import { embedKnowledgeDocument } from "@/src/application/lib/knowledge/embedding-service";
import { PrefixLogger } from "@/lib/utils";
import { nanoid } from "nanoid";
import type { KnowledgeDocumentType } from "@/src/entities/models/knowledge-document";
import type { ScoreFormatOutputType } from "@/src/entities/models/score-format";

const logger = new PrefixLogger("replicate-to-company");

function toProjectId(slug: string): string {
  return `newtest-${slug}-project`;
}

function toKnowledgeDoc(raw: any): KnowledgeDocumentType {
  const { _id, ...rest } = raw;
  return { ...rest, id: String(_id) } as KnowledgeDocumentType;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session, companySlug } = body;

    if (!session || !companySlug) {
      return Response.json(
        { error: "session and companySlug are required" },
        { status: 400 },
      );
    }

    const sourceProjectId = toProjectId(session);

    let project = await db.collection("projects").findOne({ companySlug });
    if (!project) {
      const result = await db.collection("projects").insertOne({
        companySlug,
        name: companySlug,
        createdAt: new Date().toISOString(),
      });
      project = { _id: result.insertedId, companySlug };
    }
    const targetProjectId = String(project._id);
    const now = new Date().toISOString();

    // -----------------------------------------------------------------------
    // 1. Copy pipeline result collections (inputs, pass1, pass2)
    // -----------------------------------------------------------------------
    const inputs = await db.collection("new_test_inputs").findOne(
      { projectId: sourceProjectId },
      { sort: { createdAt: -1 } },
    );
    const pass1 = await db.collection("new_test_pidrax_results").findOne(
      { projectId: sourceProjectId },
      { sort: { createdAt: -1 } },
    );
    const pass2 = await db.collection("new_test_pidrax_pass2_results").findOne(
      { projectId: sourceProjectId },
      { sort: { createdAt: -1 } },
    );

    const stats = {
      inputs: false, pass1: false, pass2: false,
      documents: 0, entities: 0, embedded: 0, kbPagesEmbedded: 0,
    };

    if (inputs?.inputs) {
      await db.collection("pidrax_inputs").updateOne(
        { projectId: targetProjectId },
        {
          $set: { projectId: targetProjectId, companySlug, inputs: inputs.inputs, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      stats.inputs = true;
    }

    if (pass1?.data) {
      await db.collection("pidrax_pass1_results").updateOne(
        { projectId: targetProjectId },
        {
          $set: {
            projectId: targetProjectId,
            companySlug,
            data: pass1.data,
            pagePlan: pass1.pagePlan,
            crossValidation: pass1.crossValidation,
            metrics: pass1.metrics,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      stats.pass1 = true;
    }

    if (pass2?.data) {
      await db.collection("pidrax_pass2_results").updateOne(
        { projectId: targetProjectId },
        {
          $set: {
            projectId: targetProjectId,
            companySlug,
            data: pass2.data,
            verificationGroups: pass2.verificationGroups,
            factClusters: pass2.factClusters,
            metrics: pass2.metrics,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      stats.pass2 = true;
    }

    // -----------------------------------------------------------------------
    // 2. Copy knowledge_documents with updated projectId
    // -----------------------------------------------------------------------
    const sourceDocs = await db.collection("knowledge_documents")
      .find({ projectId: sourceProjectId })
      .toArray();

    if (sourceDocs.length > 0) {
      await db.collection("knowledge_documents").deleteMany({ projectId: targetProjectId });

      const clonedDocs = sourceDocs.map(doc => {
        const { _id, ...rest } = doc;
        return { ...rest, projectId: targetProjectId, updatedAt: now };
      });
      await db.collection("knowledge_documents").insertMany(clonedDocs);
      stats.documents = clonedDocs.length;
      logger.log(`Copied ${clonedDocs.length} knowledge_documents`);
    }

    // -----------------------------------------------------------------------
    // 3. Copy knowledge_entities with updated projectId
    // -----------------------------------------------------------------------
    const sourceEntities = await db.collection("knowledge_entities")
      .find({ projectId: sourceProjectId })
      .toArray();

    if (sourceEntities.length > 0) {
      await db.collection("knowledge_entities").deleteMany({ projectId: targetProjectId });

      const clonedEntities = sourceEntities.map(ent => {
        const { _id, ...rest } = ent;
        return { ...rest, projectId: targetProjectId, updatedAt: now };
      });
      await db.collection("knowledge_entities").insertMany(clonedEntities);
      stats.entities = clonedEntities.length;
      logger.log(`Copied ${clonedEntities.length} knowledge_entities`);
    }

    // -----------------------------------------------------------------------
    // 4. Re-embed knowledge_documents into Qdrant under targetProjectId
    // -----------------------------------------------------------------------
    const targetDocs = await db.collection("knowledge_documents")
      .find({ projectId: targetProjectId })
      .toArray();

    for (const raw of targetDocs) {
      try {
        const doc = toKnowledgeDoc(raw);
        await embedKnowledgeDocument(doc, logger, { skipHashCheck: true });
        stats.embedded++;
      } catch (err) {
        logger.log(`Embedding failed for doc ${raw.title}: ${err}`);
      }
    }
    logger.log(`Embedded ${stats.embedded}/${targetDocs.length} source documents`);

    // -----------------------------------------------------------------------
    // 5. Create + embed synthetic KB page documents from Pass 2
    // -----------------------------------------------------------------------
    if (pass2?.data) {
      const kbData = pass2.data as ScoreFormatOutputType;
      const allPages = [...(kbData.kb_pages || []), ...(kbData.howto_pages || [])];

      for (const page of allPages) {
        const sections = page.sections || [];
        const contentParts: string[] = [];
        for (const section of sections) {
          if (section.bullets.length === 0) continue;
          contentParts.push(`## ${section.section_name}`);
          for (const bullet of section.bullets) {
            contentParts.push(`- [${bullet.item_type}] ${bullet.item_text}`);
          }
        }
        const content = contentParts.join("\n");
        if (!content.trim()) continue;

        const kbDoc: KnowledgeDocumentType = {
          id: nanoid(),
          projectId: targetProjectId,
          provider: "internal",
          sourceType: "knowledge_page",
          sourceId: page.page_id,
          title: page.title,
          content,
          metadata: { category: page.category, pageId: page.page_id },
          entityRefs: [],
          syncedAt: now,
          sourceCreatedAt: now,
          version: 1,
          previousVersions: [],
          embeddingStatus: "pending",
          createdAt: now,
          updatedAt: now,
        };

        try {
          await db.collection("knowledge_documents").insertOne({
            ...kbDoc,
            _id: undefined,
          } as any);
          await embedKnowledgeDocument(kbDoc, logger, { skipHashCheck: true });
          stats.kbPagesEmbedded++;
        } catch (err) {
          logger.log(`KB page embed failed for ${page.title}: ${err}`);
        }
      }
      logger.log(`Embedded ${stats.kbPagesEmbedded}/${allPages.length} KB pages`);
    }

    return Response.json({
      ok: true,
      targetProjectId,
      companySlug,
      replicated: stats,
      replicatedAt: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Replication failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
