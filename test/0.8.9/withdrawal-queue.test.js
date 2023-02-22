const hre = require('hardhat')
const { contract, ethers } = require('hardhat')
const { bn, getEventArgument, ZERO_ADDRESS } = require('@aragon/contract-helpers-test')

const { ETH, StETH, shareRate, shares, setBalance } = require('../helpers/utils')
const { assert } = require('../helpers/assert')
const { signPermit, makeDomainSeparator } = require('../0.6.12/helpers/permit_helpers')
const { MAX_UINT256, ACCOUNTS_AND_KEYS } = require('../0.6.12/helpers/constants')
const { impersonate, EvmSnapshot } = require('../helpers/blockchain')

const { deployWithdrawalQueue } = require('./withdrawal-queue-deploy.test')

contract('WithdrawalQueue', ([owner, stranger, daoAgent, user]) => {
  let withdrawalQueue, steth, wsteth

  const snapshot = new EvmSnapshot(ethers.provider)

  before('Deploy', async () => {
    const deployed = await deployWithdrawalQueue({
      stethOwner: owner,
      queueOwner: daoAgent,
      queuePauser: daoAgent,
      queueResumer: daoAgent
    })

    steth = deployed.steth
    wsteth = deployed.wsteth
    withdrawalQueue = deployed.withdrawalQueue

    await steth.setTotalPooledEther(ETH(600))
    // we need 1 ETH additionally to pay gas on finalization because coverage ingnores gasPrice=0
    await setBalance(steth.address, ETH(600 + 1))
    await steth.mintShares(user, shares(1))
    await steth.approve(withdrawalQueue.address, StETH(300), { from: user })

    await impersonate(ethers.provider, steth.address)
    await snapshot.make()
  })

  afterEach(async () => {
    await snapshot.rollback()
  })

  it('Initial properties', async () => {
    assert.equals(await withdrawalQueue.isPaused(), false)
    assert.equals(await withdrawalQueue.getLastRequestId(), 0)
    assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), 0)
    assert.equals(await withdrawalQueue.getLastCheckpointIndex(), 0)
    assert.equals(await withdrawalQueue.unfinalizedStETH(), StETH(0))
    assert.equals(await withdrawalQueue.unfinalizedRequestNumber(), 0)
    assert.equals(await withdrawalQueue.getLockedEtherAmount(), ETH(0))
  })

  context('Request', async () => {
    it('One can request a withdrawal', async () => {
      const receipt = await withdrawalQueue.requestWithdrawals([StETH(300)], owner, { from: user })
      const requestId = getEventArgument(receipt, 'WithdrawalRequested', 'requestId')

      assert.emits(receipt, 'WithdrawalRequested', {
        requestId: 1,
        requestor: user.toLowerCase(),
        owner: owner.toLowerCase(),
        amountOfStETH: StETH(300),
        amountOfShares: shares(1)
      })

      assert.equals(await withdrawalQueue.getLastRequestId(), requestId)
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), 0)
      assert.equals(await withdrawalQueue.unfinalizedRequestNumber(), 1)
      assert.equals(await withdrawalQueue.unfinalizedStETH(), StETH(300))
      assert.equals(await withdrawalQueue.getWithdrawalRequests(owner), [1])

      const requests = await withdrawalQueue.getWithdrawalStatus([requestId])
      assert.equals(requests.length, 1)

      const request = requests[0]

      assert.equals(request.owner, owner)
      assert.equals(request.amountOfStETH, StETH(300))
      assert.equals(request.amountOfShares, shares(1))
      assert.equals(request.isFinalized, false)
      assert.equals(request.isClaimed, false)
    })

    it('One cant request less than MIN', async () => {
      const min = bn(await withdrawalQueue.MIN_STETH_WITHDRAWAL_AMOUNT())
      assert.equals(min, 100)

      const amount = min.sub(bn(1))

      await assert.reverts(
        withdrawalQueue.requestWithdrawals([amount], owner, { from: user }),
        `RequestAmountTooSmall(${amount})`
      )
    })

    it('One can request MIN', async () => {
      const min = await withdrawalQueue.MIN_STETH_WITHDRAWAL_AMOUNT()
      const shares = await steth.getSharesByPooledEth(min)

      const receipt = await withdrawalQueue.requestWithdrawals([min], owner, { from: user })
      const requestId = getEventArgument(receipt, 'WithdrawalRequested', 'requestId')

      assert.emits(receipt, 'WithdrawalRequested', {
        requestId: 1,
        requestor: user.toLowerCase(),
        owner: owner.toLowerCase(),
        amountOfStETH: min,
        amountOfShares: shares
      })

      assert.equals(await withdrawalQueue.getLastRequestId(), requestId)
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), 0)

      const request = (await withdrawalQueue.getWithdrawalStatus([requestId]))[0]

      assert.equals(request.owner, owner)
      assert.equals(request.amountOfStETH, min)
      assert.equals(request.amountOfShares, shares)
      assert.equals(request.isFinalized, false)
      assert.equals(request.isClaimed, false)
    })

    it('One cant request more than MAX', async () => {
      const max = bn(await withdrawalQueue.MAX_STETH_WITHDRAWAL_AMOUNT())
      const amount = max.add(bn(1))
      await steth.setTotalPooledEther(amount)
      await steth.approve(withdrawalQueue.address, amount, { from: user })

      await assert.reverts(
        withdrawalQueue.requestWithdrawals([amount], owner, { from: user }),
        `RequestAmountTooLarge(${amount})`
      )
    })

    it('One can request MAX', async () => {
      const max = await withdrawalQueue.MAX_STETH_WITHDRAWAL_AMOUNT()
      await steth.setTotalPooledEther(max.muln(2))
      await steth.approve(withdrawalQueue.address, max, { from: user })

      const receipt = await withdrawalQueue.requestWithdrawals([max], owner, { from: user })
      const requestId = getEventArgument(receipt, 'WithdrawalRequested', 'requestId')

      assert.emits(receipt, 'WithdrawalRequested', {
        requestId: 1,
        requestor: user.toLowerCase(),
        owner: owner.toLowerCase(),
        amountOfStETH: max,
        amountOfShares: shares(1)
      })

      assert.equals(await withdrawalQueue.getLastRequestId(), requestId)
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), 0)

      const request = (await withdrawalQueue.getWithdrawalStatus([requestId]))[0]

      assert.equals(request.owner, owner)
      assert.equals(request.amountOfStETH, max)
      assert.equals(request.amountOfShares, shares(1))
      assert.equals(request.isFinalized, false)
      assert.equals(request.isClaimed, false)
    })

    it('One cant request more than they have', async () => {
      await assert.reverts(
        withdrawalQueue.requestWithdrawals([StETH(400)], owner, { from: user }),
        'TRANSFER_AMOUNT_EXCEEDS_ALLOWANCE'
      )
    })

    it('One cant request more than allowed', async () => {
      await steth.approve(withdrawalQueue.address, StETH(200), { from: user })

      await assert.reverts(
        withdrawalQueue.requestWithdrawals([StETH(300)], owner, { from: user }),
        'TRANSFER_AMOUNT_EXCEEDS_ALLOWANCE'
      )
    })
  })

  context('Finalization', async () => {
    const amount = bn(ETH(300))

    beforeEach('Enqueue a request', async () => {
      await withdrawalQueue.requestWithdrawals([amount], owner, { from: user })
    })

    it('Calculate one request batch', async () => {
      const batch = await withdrawalQueue.finalizationBatch(1, shareRate(300))

      assert.equals(batch.ethToLock, ETH(300))
      assert.equals(batch.sharesToBurn, shares(1))
    })

    it('Finalizer can finalize a request', async () => {
      await assert.reverts(
        withdrawalQueue.finalize(1, { from: stranger }),
        `AccessControl: account ${stranger.toLowerCase()} is missing role ${await withdrawalQueue.FINALIZE_ROLE()}`
      )
      await withdrawalQueue.finalize(1, { from: steth.address, value: amount })

      assert.equals(await withdrawalQueue.getLockedEtherAmount(), amount)
      assert.equals(
        await withdrawalQueue.getLockedEtherAmount(),
        await ethers.provider.getBalance(withdrawalQueue.address)
      )
    })

    it('One can finalize requests with discount', async () => {
      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH(150) })

      assert.equals(await withdrawalQueue.getLockedEtherAmount(), ETH(150))
      assert.equals(
        await withdrawalQueue.getLockedEtherAmount(),
        await ethers.provider.getBalance(withdrawalQueue.address)
      )
    })

    it('Same discounts is squashed into one', async () => {
      await steth.setTotalPooledEther(ETH(900))
      await steth.mintShares(user, shares(1))
      await steth.approve(withdrawalQueue.address, StETH(300), { from: user })

      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH(10) })
      assert.equals(await withdrawalQueue.getLastCheckpointIndex(), 1)

      await withdrawalQueue.requestWithdrawals([amount], owner, { from: user })
      await withdrawalQueue.finalize(2, { from: steth.address, value: ETH(10) })

      assert.equals(await withdrawalQueue.getLastCheckpointIndex(), 1)
    })

    it('One can finalize a batch of requests at once', async () => {
      await steth.setTotalPooledEther(ETH(900))
      await steth.mintShares(user, shares(1))
      await steth.approve(withdrawalQueue.address, StETH(300), { from: user })

      await withdrawalQueue.requestWithdrawals([amount], owner, { from: user })
      const batch = await withdrawalQueue.finalizationBatch(2, shareRate(300))
      await withdrawalQueue.finalize(2, { from: steth.address, value: batch.ethToLock })

      assert.equals(batch.sharesToBurn, shares(2))
      assert.equals(await withdrawalQueue.getLastRequestId(), 2)
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), 2)
      assert.equals(await withdrawalQueue.getLockedEtherAmount(), ETH(600))
      assert.equals(
        await withdrawalQueue.getLockedEtherAmount(),
        await ethers.provider.getBalance(withdrawalQueue.address)
      )
    })

    it('One can finalize part of the queue', async () => {
      await steth.setTotalPooledEther(ETH(900))
      await steth.mintShares(user, shares(1))
      await steth.approve(withdrawalQueue.address, StETH(600), { from: user })

      await withdrawalQueue.requestWithdrawals([amount], owner, { from: user })

      await withdrawalQueue.finalize(1, { from: steth.address, value: amount })

      assert.equals(await withdrawalQueue.getLastRequestId(), 2)
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), 1)
      assert.equals(await withdrawalQueue.getLockedEtherAmount(), ETH(300))
      assert.equals(
        await withdrawalQueue.getLockedEtherAmount(),
        await ethers.provider.getBalance(withdrawalQueue.address)
      )

      await withdrawalQueue.finalize(2, { from: steth.address, value: amount })

      assert.equals(await withdrawalQueue.getLastRequestId(), 2)
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), 2)
      assert.equals(await withdrawalQueue.getLockedEtherAmount(), ETH(600))
      assert.equals(
        await withdrawalQueue.getLockedEtherAmount(),
        await ethers.provider.getBalance(withdrawalQueue.address)
      )
    })
  })

  context('getClaimableEth()', () => {
    beforeEach(async () => {
      await withdrawalQueue.requestWithdrawals([ETH(1)], owner, { from: user })
    })

    it('works', async () => {
      await withdrawalQueue.requestWithdrawals([ETH(1)], owner, { from: user })
      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH(1) })

      assert.equals(await withdrawalQueue.getClaimableEther([1], [1]), ETH(1))
    })

    it('return 0 for non-finalized request', async () => {
      assert.equals(await withdrawalQueue.getClaimableEther([1], [1]), ETH(0))
      assert.equals(await withdrawalQueue.getClaimableEther([1], [51]), ETH(0))
    })

    it('return 0 for claimed request', async () => {
      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH(1) })
      await withdrawalQueue.claimWithdrawals([1], [1], { from: owner })

      assert.equals(await withdrawalQueue.getClaimableEther([1], [1]), ETH(0))
      assert.equals(await withdrawalQueue.getClaimableEther([1], [51]), ETH(0))
    })

    it('reverts on invalid params', async () => {
      await assert.reverts(withdrawalQueue.getClaimableEther([0], [1]), 'InvalidRequestId(0)')
      await assert.reverts(withdrawalQueue.getClaimableEther([2], [1]), 'InvalidRequestId(2)')

      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH(1) })
      await assert.reverts(withdrawalQueue.getClaimableEther([1], [2]), 'InvalidHint(2)')
      await assert.reverts(withdrawalQueue.getClaimableEther([1], [0]), 'InvalidHint(0)')

      await withdrawalQueue.requestWithdrawals([ETH(1)], owner, { from: user })
      await assert.reverts(withdrawalQueue.getClaimableEther([1], [2]), 'InvalidHint(2)')

      await withdrawalQueue.requestWithdrawals([ETH(1), [ETH(1)]], owner, { from: user })
      await withdrawalQueue.finalize(2, { from: steth.address, value: ETH(0.99) })
      await withdrawalQueue.finalize(3, { from: steth.address, value: ETH(0.98) })

      await assert.reverts(withdrawalQueue.getClaimableEther([3], [1]), 'InvalidHint(1)')
    })
  })

  context('claimWithdrawal()', async () => {
    const amount = ETH(300)
    beforeEach('Enqueue a request', async () => {
      await withdrawalQueue.requestWithdrawals([amount], owner, { from: user })
    })

    it('Owner can claim a finalized request to recipient address', async () => {
      await withdrawalQueue.finalize(1, { from: steth.address, value: amount })

      const balanceBefore = bn(await ethers.provider.getBalance(user))

      await withdrawalQueue.claimWithdrawalsTo([1], [1], user, { from: owner })

      assert.equals(await ethers.provider.getBalance(user), balanceBefore.add(bn(amount)))
    })

    it('Owner can claim a finalized request without hint', async () => {
      await withdrawalQueue.finalize(1, { from: steth.address, value: amount })

      const balanceBefore = bn(await ethers.provider.getBalance(owner))

      const tx = await withdrawalQueue.claimWithdrawal(1, { from: owner })

      // tx.receipt.gasUsed is a workaround for coverage, because it ignores gasPrice=0
      assert.almostEqual(await ethers.provider.getBalance(owner), balanceBefore.add(bn(amount)), tx.receipt.gasUsed)
    })

    it('One cant claim not finalized or not existed request', async () => {
      await assert.reverts(
        withdrawalQueue.claimWithdrawals([1], [1], { from: owner }),
        `RequestNotFoundOrNotFinalized(1)`
      )
      await assert.reverts(
        withdrawalQueue.claimWithdrawals([2], [1], { from: owner }),
        `RequestNotFoundOrNotFinalized(2)`
      )
    })

    it('Cant claim request with a wrong hint', async () => {
      await steth.setTotalPooledEther(ETH(900))
      await steth.mintShares(user, shares(1))
      await steth.approve(withdrawalQueue.address, StETH(600), { from: user })

      await withdrawalQueue.requestWithdrawals([amount], owner, { from: user })

      await withdrawalQueue.finalize(2, { from: steth.address, value: amount })
      await assert.reverts(withdrawalQueue.claimWithdrawals([1], [0], { from: owner }), 'InvalidHint(0)')
      await assert.reverts(withdrawalQueue.claimWithdrawals([1], [2], { from: owner }), 'InvalidHint(2)')
    })

    it('Cant withdraw token two times', async () => {
      await withdrawalQueue.finalize(1, { from: steth.address, value: amount })
      await withdrawalQueue.claimWithdrawal(1, { from: owner })

      await assert.reverts(withdrawalQueue.claimWithdrawal(1, { from: owner }), 'RequestAlreadyClaimed(1)')
    })

    it('Discounted withdrawals produce less eth', async () => {
      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH(150) })

      const balanceBefore = bn(await ethers.provider.getBalance(owner))
      assert.equals(await withdrawalQueue.getLockedEtherAmount(), ETH(150))

      const tx = await withdrawalQueue.claimWithdrawal(1, { from: owner })
      assert.equals(await withdrawalQueue.getLockedEtherAmount(), ETH(0))

      // tx.receipt.gasUsed is a workaround for coverage, because it ignores gasPrice=0
      assert.almostEqual(bn(await ethers.provider.getBalance(owner)).sub(balanceBefore), ETH(150), tx.receipt.gasUsed)
    })

    it('One can claim a lot of withdrawals with different discounts', async () => {
      await steth.setTotalPooledEther(ETH(22))
      await steth.mintShares(user, shares(21))
      await steth.approve(withdrawalQueue.address, StETH(21), { from: user })

      assert.equals(await withdrawalQueue.getLastCheckpointIndex(), 0)
      await withdrawalQueue.finalize(1, { from: steth.address, value: amount })

      for (let i = 1; i <= 20; i++) {
        assert.equals(await withdrawalQueue.getLastCheckpointIndex(), i)
        await withdrawalQueue.requestWithdrawals([StETH(1)], ZERO_ADDRESS, { from: user })
        await withdrawalQueue.finalize(i + 1, { from: steth.address, value: bn(ETH(1)).sub(bn(i * 1000)) })
      }

      assert.equals(await withdrawalQueue.getLastCheckpointIndex(), 21)

      for (let i = 21; i > 1; i--) {
        await withdrawalQueue.claimWithdrawal(i, { from: user })
      }

      await withdrawalQueue.claimWithdrawal(1, { from: owner })

      assert.equals(await withdrawalQueue.getLockedEtherAmount(), ETH(0))
    })
  })

  context('findLastFinalizableRequestIdByTimestamp()', async () => {
    const numOfRequests = 10

    beforeEach(async () => {
      for (let i = 1; i <= numOfRequests; i++) {
        await withdrawalQueue.requestWithdrawals([ETH(20)], owner, { from: user })
      }
    })

    it('works', async () => {
      for (let i = 1; i <= numOfRequests; i++) {
        const timestamp = (await withdrawalQueue.getWithdrawalStatus([i]))[0].timestamp
        assert.equals(await withdrawalQueue.findLastFinalizableRequestIdByTimestamp(timestamp, 1, 10), i)
      }
    })

    it('returns zero on empty range', async () => {
      assert.equals(await withdrawalQueue.findLastFinalizableRequestIdByTimestamp(1, 2, 1), 0)
    })

    it('return zero if no unfinalized request found', async () => {
      const timestamp = (await withdrawalQueue.getWithdrawalStatus([1]))[0].timestamp

      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH[10] })
      assert.equals(await withdrawalQueue.findLastFinalizableRequestIdByTimestamp(timestamp, 2, 10), 0)
    })

    it('checks params', async () => {
      await assert.reverts(withdrawalQueue.findLastFinalizableRequestIdByTimestamp(0, 0, 10), 'ZeroTimestamp()')

      const timestamp = (await withdrawalQueue.getWithdrawalStatus([2]))[0].timestamp

      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByTimestamp(timestamp, 0, 10),
        'InvalidRequestIdRange(0, 10)'
      )

      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByTimestamp(timestamp, 0, 11),
        'InvalidRequestIdRange(0, 11)'
      )

      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH(20) })
      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByTimestamp(timestamp, 1, 10),
        'InvalidRequestIdRange(1, 10)'
      )

      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByTimestamp(timestamp, 2, 1000),
        'InvalidRequestIdRange(2, 1000)'
      )
    })
  })

  context('findLastFinalizableRequestIdByBudget()', async () => {
    const numOfRequests = 10

    beforeEach(async () => {
      for (let i = 1; i <= numOfRequests; i++) {
        await withdrawalQueue.requestWithdrawals([ETH(20)], owner, { from: user })
      }
    })

    it('works', async () => {
      // 1e18 shares is 300e18 ether, let's discount to 150
      const rate = shareRate(150)

      for (let i = 1; i <= numOfRequests; i++) {
        const budget = ETH(i * 10 + 5)
        assert.equals(await withdrawalQueue.findLastFinalizableRequestIdByBudget(budget, rate, 1, 10), i)
      }
    })

    it('return zero if no unfinalized request found', async () => {
      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH[10] })
      assert.equals(await withdrawalQueue.findLastFinalizableRequestIdByBudget(ETH(1), shareRate(300), 2, 10), 0)
    })

    it('returns zero on empty range', async () => {
      assert.equals(await withdrawalQueue.findLastFinalizableRequestIdByBudget(ETH(1), shareRate(300), 2, 1), 0)
    })

    it('checks params', async () => {
      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByBudget(ETH(0), shareRate(300), 0, 10),
        'ZeroAmountOfETH()'
      )

      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByBudget(ETH(1), shareRate(0), 0, 10),
        'ZeroShareRate()'
      )

      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByBudget(ETH(1), shareRate(300), 0, 10),
        'InvalidRequestIdRange(0, 10)'
      )

      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByBudget(ETH(1), shareRate(300), 0, 11),
        'InvalidRequestIdRange(0, 11)'
      )

      await withdrawalQueue.finalize(1, { from: steth.address, value: ETH(20) })
      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByBudget(ETH(1), shareRate(300), 1, 10),
        'InvalidRequestIdRange(1, 10)'
      )

      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByBudget(ETH(1), shareRate(300), 1, 10),
        'InvalidRequestIdRange(1, 10)'
      )
      await assert.reverts(
        withdrawalQueue.findLastFinalizableRequestIdByBudget(ETH(1), shareRate(300), 2, 1000),
        'InvalidRequestIdRange(2, 1000)'
      )
    })
  })

  context('findLastFinalizableRequestId()', async () => {
    const numOfRequests = 10

    beforeEach(async () => {
      for (let i = 1; i <= numOfRequests + 1; i++) {
        await withdrawalQueue.requestWithdrawals([ETH(20)], owner, { from: user })
      }
    })

    it('works', async () => {
      for (let i = 1; i <= numOfRequests; i++) {
        const budget = ETH(i * 10 + 5)
        const timestamp = (await withdrawalQueue.getWithdrawalStatus([i]))[0].timestamp
        assert.equals(await withdrawalQueue.findLastFinalizableRequestId(budget, shareRate(150), timestamp), i)
      }
    })

    it('returns zero if no unfinalized requests', async () => {
      await withdrawalQueue.finalize(10, { from: steth.address, value: ETH[10] })

      const timestamp = (await withdrawalQueue.getWithdrawalStatus([10]))[0].timestamp
      assert.equals(await withdrawalQueue.findLastFinalizableRequestId(ETH(100), shareRate(100), timestamp), 0)
    })

    it('checks params', async () => {
      await assert.reverts(withdrawalQueue.findLastFinalizableRequestId(ETH(0), shareRate(300), 1), 'ZeroAmountOfETH()')

      await assert.reverts(withdrawalQueue.findLastFinalizableRequestId(ETH(1), shareRate(0), 1), 'ZeroShareRate()')

      await assert.reverts(withdrawalQueue.findLastFinalizableRequestId(ETH(1), shareRate(1), 0), 'ZeroTimestamp()')
    })
  })

  context('findCheckpointsHint()', async () => {
    const numOfRequests = 10
    const requests = Array(numOfRequests).fill(ETH(20))
    const discountedPrices = Array(numOfRequests)
      .fill()
      .map((_, i) => ETH(i))

    beforeEach(async () => {
      await withdrawalQueue.requestWithdrawals(requests, owner, { from: user })
      for (let i = 1; i <= numOfRequests; i++) {
        await withdrawalQueue.finalize(i, { from: steth.address, value: discountedPrices[i] })
      }
      assert.equals(await withdrawalQueue.getLastCheckpointIndex(), numOfRequests)
      assert.equals(
        await withdrawalQueue.findCheckpointHintsUnbounded([await withdrawalQueue.getLastFinalizedRequestId()]),
        await withdrawalQueue.getLastCheckpointIndex()
      )
    })

    it('works unbounded', async () => {
      assert.equals(
        await withdrawalQueue.findCheckpointHintsUnbounded([10]),
        await withdrawalQueue.getLastCheckpointIndex()
      )
    })

    it('reverts if request is not finalized', async () => {
      await withdrawalQueue.requestWithdrawals([ETH(1)], owner, { from: user })
      await assert.reverts(withdrawalQueue.findCheckpointHints([11], 1, 10), 'RequestNotFoundOrNotFinalized(11)')
      await assert.reverts(withdrawalQueue.findCheckpointHintsUnbounded([11]), 'RequestNotFoundOrNotFinalized(11)')
    })

    it('reverts if there is no such a request', async () => {
      await assert.reverts(withdrawalQueue.findCheckpointHints([12], 1, 10), 'RequestNotFoundOrNotFinalized(12)')
      await assert.reverts(withdrawalQueue.findCheckpointHintsUnbounded([12]), 'RequestNotFoundOrNotFinalized(12)')
    })

    it('range search (found)', async () => {
      assert.equals(await withdrawalQueue.findCheckpointHints([5], 1, 9), 5)
      assert.equals(await withdrawalQueue.findCheckpointHints([1], 1, 9), 1)
      assert.equals(await withdrawalQueue.findCheckpointHints([9], 1, 9), 9)
      assert.equals(await withdrawalQueue.findCheckpointHints([5], 5, 5), 5)
    })

    it('range search (not found)', async () => {
      assert.equals(await withdrawalQueue.findCheckpointHints([10], 1, 5), 0)
      assert.equals(await withdrawalQueue.findCheckpointHints([6], 1, 5), 0)
      assert.equals(await withdrawalQueue.findCheckpointHints([1], 5, 5), 0)
      assert.equals(await withdrawalQueue.findCheckpointHints([4], 5, 9), 0)
    })

    it('sequential search', async () => {
      for ([idToFind, searchLength] of [
        [1, 3],
        [1, 10],
        [10, 2],
        [10, 3],
        [8, 2],
        [9, 3]
      ]) {
        assert.equals(await sequentialSearch(idToFind, searchLength), idToFind)
      }
    })

    const sequentialSearch = async (requestId, searchLength) => {
      let lastIndex = await withdrawalQueue.getLastCheckpointIndex()

      for (let i = 1; i <= lastIndex; i += searchLength) {
        let end = i + searchLength - 1
        if (end > lastIndex) end = lastIndex
        let foundIndex = await withdrawalQueue.findCheckpointHints([requestId], i, end)
        if (foundIndex != 0) return foundIndex
      }
    }
  })

  context('findCheckpointHints()', () => {
    let requestId
    const amount = ETH(20)

    beforeEach('Enqueue a request', async () => {
      await withdrawalQueue.requestWithdrawals([amount], owner, { from: user })
      requestId = await withdrawalQueue.getLastRequestId()
    })

    it('returns empty list when passed empty request ids list', async () => {
      const lastCheckpointIndex = await withdrawalQueue.getLastCheckpointIndex()
      const hints = await withdrawalQueue.findCheckpointHints([], 1, lastCheckpointIndex)
      assert.equal(hints.length, 0)
    })

    it('returns not found when indexes have negative overlap', async () => {
      const batch = await withdrawalQueue.finalizationBatch(requestId, shareRate(300))
      await withdrawalQueue.finalize(requestId, { from: steth.address, value: batch.ethToLock })
      const lastCheckpointIndex = await withdrawalQueue.getLastCheckpointIndex()
      const hints = await withdrawalQueue.findCheckpointHints(
        [requestId],
        +lastCheckpointIndex + 1,
        lastCheckpointIndex
      )
      assert.equal(hints.length, 1)
      assert.equals(hints[0], 0)
    })

    it('returns hints array with one item for list from single request id', async () => {
      const batch = await withdrawalQueue.finalizationBatch(requestId, shareRate(300))
      await withdrawalQueue.finalize(requestId, { from: steth.address, value: batch.ethToLock })
      const lastCheckpointIndex = await withdrawalQueue.getLastCheckpointIndex()
      const hints = await withdrawalQueue.findCheckpointHints([requestId], 1, lastCheckpointIndex)
      assert.equal(hints.length, 1)
      assert.equals(hints[0], 1)
    })

    it('returns correct hints array for given request ids', async () => {
      await withdrawalQueue.finalize(requestId, { from: steth.address, value: ETH(20) })

      await steth.mintShares(owner, shares(1))
      await steth.approve(withdrawalQueue.address, StETH(300), { from: owner })

      const secondRequestAmount = ETH(10)
      await withdrawalQueue.requestWithdrawals([secondRequestAmount], owner, { from: owner })
      const secondRequestId = await withdrawalQueue.getLastRequestId()

      const thirdRequestAmount = ETH(30)
      await withdrawalQueue.requestWithdrawals([thirdRequestAmount], user, { from: user })
      const thirdRequestId = await withdrawalQueue.getLastRequestId()

      await withdrawalQueue.finalize(thirdRequestId, { from: steth.address, value: ETH(40) })

      const lastCheckpointIndex = await withdrawalQueue.getLastCheckpointIndex()
      const hints = await withdrawalQueue.findCheckpointHints(
        [requestId, secondRequestId, thirdRequestId],
        1,
        lastCheckpointIndex
      )
      assert.equal(hints.length, 3)
      assert.equals(hints[0], 1)
      assert.equals(hints[1], 1)
      assert.equals(hints[2], 1)
    })

    it('reverts with RequestIdsNotSorted error when request ids not in ascending order', async () => {
      await withdrawalQueue.finalize(requestId, { from: steth.address, value: ETH(20) })

      await steth.mintShares(owner, shares(1))
      await steth.approve(withdrawalQueue.address, StETH(300), { from: owner })

      const secondRequestAmount = ETH(10)
      await withdrawalQueue.requestWithdrawals([secondRequestAmount], owner, { from: owner })
      const secondRequestId = await withdrawalQueue.getLastRequestId()

      const thirdRequestAmount = ETH(30)
      await withdrawalQueue.requestWithdrawals([thirdRequestAmount], user, { from: user })
      const thirdRequestId = await withdrawalQueue.getLastRequestId()

      await withdrawalQueue.finalize(thirdRequestId, { from: steth.address, value: ETH(40) })

      const lastCheckpointIndex = await withdrawalQueue.getLastCheckpointIndex()
      await assert.reverts(
        withdrawalQueue.findCheckpointHints([requestId, thirdRequestId, secondRequestId], 1, lastCheckpointIndex),
        'RequestIdsNotSorted()'
      )
    })
  })

  context('findCheckpointHintsUnbounded()', () => {
    let requestId
    const amount = ETH(20)

    beforeEach('Enqueue a request', async () => {
      await withdrawalQueue.requestWithdrawals([amount], owner, { from: user })
      requestId = await withdrawalQueue.getLastRequestId()
    })

    it('returns correct hints array for given request ids', async () => {
      await withdrawalQueue.finalize(requestId, { from: steth.address, value: ETH(20) })

      await steth.mintShares(owner, shares(1))
      await steth.approve(withdrawalQueue.address, StETH(300), { from: owner })

      const secondRequestAmount = ETH(10)
      await withdrawalQueue.requestWithdrawals([secondRequestAmount], owner, { from: owner })
      const secondRequestId = await withdrawalQueue.getLastRequestId()

      const thirdRequestAmount = ETH(30)
      await withdrawalQueue.requestWithdrawals([thirdRequestAmount], user, { from: user })
      const thirdRequestId = await withdrawalQueue.getLastRequestId()

      await withdrawalQueue.finalize(thirdRequestId, { from: steth.address, value: ETH(40) })

      const hints = await withdrawalQueue.findCheckpointHintsUnbounded([requestId, secondRequestId, thirdRequestId])
      assert.equal(hints.length, 3)
      assert.equals(hints[0], 1)
      assert.equals(hints[1], 1)
      assert.equals(hints[2], 1)
    })
  })

  context('claimWithdrawals()', () => {
    let requestId
    const amount = ETH(20)

    beforeEach('Enqueue a request', async () => {
      await withdrawalQueue.requestWithdrawals([amount], owner, { from: user })
      requestId = await withdrawalQueue.getLastRequestId()
    })

    it('claims correct requests', async () => {
      await steth.mintShares(owner, shares(300)) // 1 share to user and 299 shares to owner total = 300 ETH
      await steth.approve(withdrawalQueue.address, StETH(300), { from: owner })

      const secondRequestAmount = ETH(10)
      await withdrawalQueue.requestWithdrawals([secondRequestAmount], owner, { from: owner })
      const secondRequestId = await withdrawalQueue.getLastRequestId()
      await withdrawalQueue.finalize(secondRequestId, { from: steth.address, value: ETH(30) })

      const balanceBefore = bn(await ethers.provider.getBalance(owner))
      const tx = await withdrawalQueue.claimWithdrawals([1, 2], [1, 1], { from: owner })
      // tx.receipt.gasUsed is a workaround for coverage, because it ignores gasPrice=0
      assert.almostEqual(await ethers.provider.getBalance(owner), balanceBefore.add(bn(ETH(30))), tx.receipt.gasUsed)
    })
  })

  context('requestWithdrawals()', () => {
    it('works correctly with non empty payload and different tokens', async () => {
      await steth.mintShares(user, shares(10))
      await steth.approve(withdrawalQueue.address, StETH(300), { from: user })
      const requests = [ETH(10), ETH(20)]
      const stETHBalanceBefore = await steth.balanceOf(user)
      const lastRequestIdBefore = await withdrawalQueue.getLastRequestId()

      await withdrawalQueue.requestWithdrawals(requests, stranger, { from: user })

      assert.equals(await withdrawalQueue.getLastRequestId(), lastRequestIdBefore.add(bn(requests.length)))
      const stETHBalanceAfter = await steth.balanceOf(user)
      assert.almostEqual(stETHBalanceAfter, stETHBalanceBefore.sub(bn(requests[0])).sub(bn(requests[1])), 30)
    })
  })

  context('requestWithdrawalsWstETH()', () => {
    it('works correctly with non empty payload and different tokens', async () => {
      await wsteth.mint(user, ETH(100))
      await steth.mintShares(wsteth.address, shares(100))
      await steth.mintShares(user, shares(100))
      await wsteth.approve(withdrawalQueue.address, ETH(300), { from: user })
      const requests = [ETH(10), ETH(20)]
      const wstETHBalanceBefore = await wsteth.balanceOf(user)
      const lastRequestIdBefore = await withdrawalQueue.getLastRequestId()

      await withdrawalQueue.requestWithdrawalsWstETH(requests, stranger, { from: user })

      assert.equals(await withdrawalQueue.getLastRequestId(), lastRequestIdBefore.add(bn(requests.length)))
      const wstETHBalanceAfter = await wsteth.balanceOf(user)
      assert.equals(wstETHBalanceAfter, wstETHBalanceBefore.sub(bn(requests[0])).sub(bn(requests[1])))
    })
  })

  context('requestWithdrawalsWstETHWithPermit()', () => {
    const [alice] = ACCOUNTS_AND_KEYS
    it('works correctly with non empty payload', async () => {
      await wsteth.mint(user, ETH(100))
      await steth.mintShares(wsteth.address, shares(100))
      await steth.mintShares(user, shares(100))
      await wsteth.approve(withdrawalQueue.address, ETH(300), { from: user })
      await impersonate(hre.ethers.provider, alice.address)
      await web3.eth.sendTransaction({ to: alice.address, from: user, value: ETH(1) })
      await wsteth.transfer(alice.address, ETH(100), { from: user })

      const requests = []

      const withdrawalRequestsCount = 5
      for (let i = 0; i < withdrawalRequestsCount; ++i) {
        requests.push(ETH(10))
      }

      const amount = bn(ETH(10)).mul(bn(withdrawalRequestsCount))
      const chainId = await wsteth.getChainId()
      const deadline = MAX_UINT256
      const domainSeparator = makeDomainSeparator('Wrapped liquid staked Ether 2.0', '1', chainId, wsteth.address)
      const { v, r, s } = signPermit(
        alice.address,
        withdrawalQueue.address,
        amount, // amount
        0, // nonce
        deadline,
        domainSeparator,
        alice.key
      )
      const permission = [
        amount,
        deadline, // deadline
        v,
        r,
        s
      ]

      const aliceBalancesBefore = await wsteth.balanceOf(alice.address)
      const lastRequestIdBefore = await withdrawalQueue.getLastRequestId()
      await withdrawalQueue.requestWithdrawalsWstETHWithPermit(requests, owner, permission, { from: alice.address })
      assert.equals(await withdrawalQueue.getLastRequestId(), lastRequestIdBefore.add(bn(requests.length)))
      const aliceBalancesAfter = await wsteth.balanceOf(alice.address)
      assert.equals(aliceBalancesAfter, aliceBalancesBefore.sub(bn(ETH(10)).mul(bn(withdrawalRequestsCount))))
    })
  })

  context('Transfer request', async () => {
    const amount = ETH(300)
    let requestId

    beforeEach('Enqueue a request', async () => {
      await withdrawalQueue.requestWithdrawals([amount], user, { from: user })
      requestId = (await withdrawalQueue.getLastRequestId()).toNumber()
    })

    it('One can change the owner', async () => {
      const senderWithdrawalsBefore = await withdrawalQueue.getWithdrawalRequests(user)
      const ownerWithdrawalsBefore = await withdrawalQueue.getWithdrawalRequests(owner)

      assert.isTrue(senderWithdrawalsBefore.map((v) => v.toNumber()).includes(requestId))
      assert.isFalse(ownerWithdrawalsBefore.map((v) => v.toNumber()).includes(requestId))

      await withdrawalQueue.transferFrom(user, owner, requestId, { from: user })

      const senderWithdrawalAfter = await withdrawalQueue.getWithdrawalRequests(user)
      const ownerWithdrawalsAfter = await withdrawalQueue.getWithdrawalRequests(owner)

      assert.isFalse(senderWithdrawalAfter.map((v) => v.toNumber()).includes(requestId))
      assert.isTrue(ownerWithdrawalsAfter.map((v) => v.toNumber()).includes(requestId))
    })

    it("One can't change someone else's request", async () => {
      await assert.reverts(
        withdrawalQueue.transferFrom(user, owner, requestId, { from: stranger }),
        `NotOwnerOrApproved("${stranger}")`
      )
    })

    it("One can't pass zero owner", async () => {
      await assert.reverts(
        withdrawalQueue.transferFrom(user, ZERO_ADDRESS, requestId, { from: user }),
        'TransferToZeroAddress()'
      )
    })

    it("One can't pass zero requestId", async () => {
      await assert.reverts(withdrawalQueue.transferFrom(user, owner, 0, { from: user }), `InvalidRequestId(0)`)
    })

    it("One can't change claimed request", async () => {
      await withdrawalQueue.finalize(requestId, { from: steth.address, value: amount })
      await withdrawalQueue.claimWithdrawal(requestId, { from: user })

      await assert.reverts(
        withdrawalQueue.transferFrom(user, owner, requestId, { from: user }),
        `RequestAlreadyClaimed(1)`
      )
    })

    it("Changing owner doesn't work with wrong request id", async () => {
      const wrongRequestId = requestId + 1
      await assert.reverts(
        withdrawalQueue.transferFrom(user, owner, wrongRequestId, { from: user }),
        `InvalidRequestId(${wrongRequestId})`
      )
    })
  })

  context('Transfer request performance', function () {
    const firstRequestCount = 1000
    const secondRequestCount = 10000

    this.timeout(1000000)

    it.skip('Can perform a lots of requests', async () => {
      for (let i = 0; i < firstRequestCount; i++) {
        await withdrawalQueue.requestWithdrawals([ETH(1 / secondRequestCount)], user, { from: user })
      }
      const firstGasUsed = (await withdrawalQueue.changeRecipient(firstRequestCount - 1, owner, { from: user })).receipt
        .gasUsed

      for (let i = firstRequestCount; i < secondRequestCount; i++) {
        await withdrawalQueue.requestWithdrawals([ETH(1 / secondRequestCount)], user, { from: user })
      }
      const secondGasUsed = (await withdrawalQueue.changeRecipient(secondRequestCount / 2, owner, { from: user }))
        .receipt.gasUsed

      assert.isTrue(firstGasUsed >= secondGasUsed)
    })
  })
})
