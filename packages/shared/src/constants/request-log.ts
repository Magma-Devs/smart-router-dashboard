/**
 * Words the two request lists share - the Transactions tab and the Errors
 * tab's request list - so one result reads the same on both.
 */

/**
 * Why a write the router could not settle is "Unknown": smart-router's
 * `write_unknown` outcome, or its older "write outcome unknown" line. No
 * upstream gave a definite answer, so the transaction may or may not be on
 * its way.
 */
export const WRITE_UNKNOWN_NOTE =
  "No upstream gave a definite answer, so the router can't tell whether the transaction reached a node. Check the chain before sending it again.";
