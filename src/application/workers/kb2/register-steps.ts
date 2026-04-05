import { registerPass1Step, registerPass2Step } from "./pipeline-runner";

import { inputSnapshotStep } from "./pass1/input-snapshot";
import { embedDocumentsStep } from "./pass1/embed-documents";
import { entityExtractionStep } from "./pass1/entity-extraction";
import { extractionValidationStepV2 as extractionValidationStep } from "./pass1/extraction-validation-v2";
import { entityResolutionStep } from "./pass1/entity-resolution";
import { graphBuildStepV2 as graphBuildStep } from "./pass1/graph-build-v2";
import { graphEnrichmentStepV2 as graphEnrichmentStep } from "./pass1/graph-enrichment-v2";
import { discoveryStepV2 as discoveryStep } from "./pass1/discovery-v2";
import { attributeCompletionStep } from "./pass1/attribute-completion";
import { patternSynthesisStepV2 as patternSynthesisStep } from "./pass1/pattern-synthesis-v2";
import { graphReEnrichmentStepV2 as graphReEnrichmentStep } from "./pass1/graph-re-enrichment-v2";
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

  // Pass 1 (18 steps)
  registerPass1Step("Input Snapshot", inputSnapshotStep);               // P1.1
  registerPass1Step("Embed Documents", embedDocumentsStep);             // P1.2
  registerPass1Step("Entity Extraction", entityExtractionStep);         // P1.3
  registerPass1Step("Extraction Validation", extractionValidationStep); // P1.4
  registerPass1Step("Entity Resolution", entityResolutionStep);         // P1.5
  registerPass1Step("Graph Build", graphBuildStep);                     // P1.6
  registerPass1Step("Graph Enrichment", graphEnrichmentStep);           // P1.7
  registerPass1Step("Project & Ticket Discovery", discoveryStep);       // P1.8
  registerPass1Step("Attribute Completion", attributeCompletionStep);   // P1.9
  registerPass1Step("Pattern Synthesis", patternSynthesisStep);         // P1.10
  registerPass1Step("Graph Re-enrichment", graphReEnrichmentStep);      // P1.11
  registerPass1Step("Page Plan", pagePlanStep);                         // P1.12
  registerPass1Step("GraphRAG Retrieval", graphragRetrievalStep);       // P1.13
  registerPass1Step("Generate Entity Pages", generateEntityPagesStep);  // P1.14
  registerPass1Step("Generate Human Pages", generateHumanPagesStep);    // P1.15
  registerPass1Step("Generate How-To Guides", generateHowtoStep);       // P1.16
  registerPass1Step("Extract Claims", extractClaimsStep);               // P1.17
  registerPass1Step("Create Verify Cards", createVerifyCardsStep);      // P1.18

  // Pass 2 (6 steps)
  registerPass2Step("Admin Refinements", adminRefinementsStep);
  registerPass2Step("Cluster FactGroups", clusterFactGroupsStep);
  registerPass2Step("Conflict Detection", conflictDetectionStep);
  registerPass2Step("Evidence Upgrade", evidenceUpgradeStep);
  registerPass2Step("Propagation", propagationStep);
  registerPass2Step("Finalize", finalizeStep);
}
