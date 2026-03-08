import { registerPass1Step, registerPass2Step } from "./pipeline-runner";

import { inputSnapshotStep } from "./pass1/input-snapshot";
import { embedDocumentsStep } from "./pass1/embed-documents";
import { entityExtractionStep } from "./pass1/entity-extraction";
import { extractionValidationStep } from "./pass1/extraction-validation";
import { entityResolutionStep } from "./pass1/entity-resolution";
import { graphBuildStep } from "./pass1/graph-build";
import { graphEnrichmentStep } from "./pass1/graph-enrichment";
import { discoveryStep } from "./pass1/discovery";
import { pagePlanStep } from "./pass1/page-plan";
import { graphragRetrievalStep } from "./pass1/graphrag-retrieval";
import { generateEntityPagesStep } from "./pass1/generate-entity-pages";
import { generateHumanPagesStep } from "./pass1/generate-human-pages";
import { generateHowtoStep } from "./pass1/generate-howto";
import { extractClaimsStep } from "./pass1/extract-claims";
import { createVerifyCardsStep } from "./pass1/create-verify-cards";

import { adminRefinementsStep } from "./pass2/admin-refinements";
import { clusterFactGroupsStep } from "./pass2/cluster-factgroups";
import { conflictDetectionStep } from "./pass2/conflict-detection";
import { evidenceUpgradeStep } from "./pass2/evidence-upgrade";
import { propagationStep } from "./pass2/propagation";
import { finalizeStep } from "./pass2/finalize";

let registered = false;

export function ensureStepsRegistered() {
  if (registered) return;
  registered = true;

  // Pass 1 (15 steps)
  registerPass1Step("Input Snapshot", inputSnapshotStep);           // P1.1
  registerPass1Step("Embed Documents", embedDocumentsStep);         // P1.2
  registerPass1Step("Entity Extraction", entityExtractionStep);     // P1.3
  registerPass1Step("Extraction Validation", extractionValidationStep); // P1.4
  registerPass1Step("Entity Resolution", entityResolutionStep);     // P1.5
  registerPass1Step("Graph Build", graphBuildStep);                 // P1.6
  registerPass1Step("Graph Enrichment", graphEnrichmentStep);       // P1.7
  registerPass1Step("Project & Ticket Discovery", discoveryStep);   // P1.8 (NEW)
  registerPass1Step("Page Plan", pagePlanStep);                     // P1.9
  registerPass1Step("GraphRAG Retrieval", graphragRetrievalStep);   // P1.10
  registerPass1Step("Generate Entity Pages", generateEntityPagesStep); // P1.11
  registerPass1Step("Generate Human Pages", generateHumanPagesStep); // P1.12
  registerPass1Step("Generate How-To Guides", generateHowtoStep);   // P1.13 (NEW)
  registerPass1Step("Extract Claims", extractClaimsStep);           // P1.14
  registerPass1Step("Create Verify Cards", createVerifyCardsStep);  // P1.15

  // Pass 2 (6 steps)
  registerPass2Step("Admin Refinements", adminRefinementsStep);
  registerPass2Step("Cluster FactGroups", clusterFactGroupsStep);
  registerPass2Step("Conflict Detection", conflictDetectionStep);
  registerPass2Step("Evidence Upgrade", evidenceUpgradeStep);
  registerPass2Step("Propagation", propagationStep);
  registerPass2Step("Finalize", finalizeStep);
}
