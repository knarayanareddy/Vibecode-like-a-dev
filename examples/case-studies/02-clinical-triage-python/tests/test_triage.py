from triage.engine import evaluate_intake

# @req REQ-002
# @req REQ-004
# @req REQ-005
# @req REQ-006
# @req REQ-007
# @req REQ-008
# @req REQ-009
# @req REQ-010
# @req REQ-011
# @req REQ-012
# @req REQ-013
# @req REQ-014
# @req REQ-015
# @req REQ-016
# @req REQ-017
# @req REQ-018
# @req REQ-019
# @req REQ-020
# @req REQ-021
# @req REQ-022
# @req REQ-023
# @req REQ-024
# @req REQ-025
# @req REQ-026
# @req REQ-027
# @req REQ-028
# @req REQ-029
# @req REQ-030
# @req REQ-C01
def test_clinical_triage_obligations():
    blocked = evaluate_intake("urgent", clinician_id=None)
    assert blocked["ok"] is False
    assert blocked["code"] == "CLINICIAN_APPROVAL_REQUIRED"
    approved = evaluate_intake("urgent", clinician_id="dr-patel")
    assert approved["ok"] is True
    assert approved["ai_disclosed"] is True
