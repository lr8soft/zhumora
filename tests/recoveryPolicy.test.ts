import assert from 'node:assert/strict'
import {
  MAX_EMPTY_CONTINUATIONS,
  MAX_TRUNCATION_CONTINUATIONS,
  RecoveryBudget
} from '../src/main/agent/recoveryPolicy.ts'

const budget = new RecoveryBudget()
for (let index = 0; index < MAX_TRUNCATION_CONTINUATIONS; index++) {
  assert.equal(budget.canRecoverTruncation(), true)
  budget.recordTruncation()
}
assert.equal(budget.canRecoverTruncation(), false)

for (let index = 0; index < MAX_EMPTY_CONTINUATIONS; index++) {
  assert.equal(budget.canRecoverEmptyResponse(), true)
  budget.recordEmptyResponse()
}
assert.equal(budget.canRecoverEmptyResponse(), false)

budget.resetAfterToolRound()
assert.equal(budget.canRecoverTruncation(), true)
assert.equal(budget.canRecoverEmptyResponse(), true)
console.log('agent recovery policy tests passed')
