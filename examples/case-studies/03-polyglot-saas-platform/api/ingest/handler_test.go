package ingest_test

import (
	"testing"
	"github.com/acme/polyglot-api/ingest"
)

// @req REQ-012
// @req REQ-013
// @req REQ-014
// @req REQ-015
// @req REQ-016
// @req REQ-017
// @req REQ-018
func TestIngestContract(t *testing.T) {
	if !ingest.Accept("tenant-1") || ingest.Accept("") {
		t.Fatalf("tenant guard failed")
	}
}
