# Phase F2: retired occurrence-selection design

This historical design is superseded by the clean-slate automatic FIFO
contract. Current one-time payments do not accept occurrence IDs, week
selectors, or per-occurrence payment parents. The server derives FIFO
allocation from tenant-scoped canonical obligations and collection-group
evidence and records one immutable tender parent plus internal allocation
children.

See [Automatic FIFO payment allocation](automatic-fifo-payment-allocation.md)
for the active quote, finalization, standing-autopay, correction, receipt, and
migration contract. This document is retained only as historical context for
the removed F2 selector behavior.
