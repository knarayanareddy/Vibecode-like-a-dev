def evaluate_intake(acuity: str, clinician_id: str | None = None, step_budget: int = 3) -> dict:
    if step_budget <= 0:
        return {"ok": False, "code": "BUDGET_EXCEEDED"}
    if acuity == "urgent" and not clinician_id:
        return {"ok": False, "code": "CLINICIAN_APPROVAL_REQUIRED"}
    return {"ok": True, "acuity": acuity, "approved_by": clinician_id, "ai_disclosed": True}
