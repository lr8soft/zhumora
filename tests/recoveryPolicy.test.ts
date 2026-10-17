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
assert.equal(budget.canRecoverTruncation(), false, 'tool rounds cannot reset the whole-run recovery ceiling')
assert.equal(budget.canRecoverEmptyResponse(), false)
const intermittent = new RecoveryBudget()
intermittent.recordEmptyResponse()
intermittent.resetAfterToolRound()
assert.equal(intermittent.canRecoverEmptyResponse(), true, 'a tool round resets consecutive counts while total remains bounded')
for (let index = 0; index < 3; index++) {
  intermittent.recordEmptyResponse()
  intermittent.resetAfterToolRound()
}
assert.equal(intermittent.canRecoverEmptyResponse(), false, 'alternating tool/empty rounds cannot evade the run budget')
console.log('agent recovery policy tests passed')
