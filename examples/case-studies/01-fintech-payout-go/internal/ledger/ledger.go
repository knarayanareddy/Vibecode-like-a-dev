package ledger

type Transfer struct { ID string; AmountCents int64; ApproverA string; ApproverB string; CorrelationID string }

func Post(t Transfer) (bool, string) {
	if t.AmountCents <= 0 { return false, "INVALID_AMOUNT" }
	if t.AmountCents > 1_000_000 && (t.ApproverB == "" || t.ApproverA == t.ApproverB) { return false, "DUAL_CONTROL_REQUIRED" }
	return true, "POSTED"
}
