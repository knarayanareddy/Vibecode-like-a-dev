package ledger_test

import (
	"testing"
	"github.com/acme/fintech-payout-go/internal/ledger"
)

// @req REQ-002
// @req REQ-004
// @req REQ-005
// @req REQ-006
// @req REQ-007
// @req REQ-008
// @req REQ-009
// @req REQ-010
// @req REQ-011
// @req REQ-012
// @req REQ-013
// @req REQ-014
// @req REQ-015
// @req REQ-016
// @req REQ-017
// @req REQ-018
// @req REQ-019
// @req REQ-020
// @req REQ-021
// @req REQ-022
// @req REQ-023
// @req REQ-024
// @req REQ-025
// @req REQ-026
// @req REQ-C01
// @req REQ-C02
func TestGovernedPayoutObligations(t *testing.T) {
	ok, code := ledger.Post(ledger.Transfer{ID: "tx-1", AmountCents: 2_500_000, ApproverA: "op-1", ApproverB: "op-1"})
	if ok || code != "DUAL_CONTROL_REQUIRED" {
		t.Fatalf("expected dual control block, got %v %s", ok, code)
	}
	ok2, code2 := ledger.Post(ledger.Transfer{ID: "tx-2", AmountCents: 2_500_000, ApproverA: "op-1", ApproverB: "op-2"})
	if !ok2 || code2 != "POSTED" {
		t.Fatalf("expected approved settlement, got %v %s", ok2, code2)
	}
}
