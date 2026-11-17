import assert from "node:assert/strict";
import { canAccessTenant } from "../src/session.js";

// @req REQ-002
// @req REQ-004
// @req REQ-005
// @req REQ-006
// @req REQ-007
// @req REQ-008
// @req REQ-011
export function testTenantBoundary() {
  assert.equal(canAccessTenant("t1", "t2"), false);
  assert.equal(canAccessTenant("t1", "t1"), true);
}
