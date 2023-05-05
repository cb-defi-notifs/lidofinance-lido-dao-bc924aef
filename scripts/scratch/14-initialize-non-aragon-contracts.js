const runOrWrapScript = require('../helpers/run-or-wrap-script')
const { log, logSplitter, logWideSplitter, yl, gr } = require('../helpers/log')
const { readNetworkState, assertRequiredNetworkState, persistNetworkState } = require('../helpers/persisted-network-state')
const { ZERO_ADDRESS, bn } = require('@aragon/contract-helpers-test')
const { web3 } = require('hardhat')

const { APP_NAMES } = require('../constants')


const DEPLOYER = process.env.DEPLOYER || ''
const REQUIRED_NET_STATE = [
  `app:${APP_NAMES.LIDO}`,
  `app:${APP_NAMES.ORACLE}`,
  "app:aragon-agent",
  "app:aragon-voting",
  "app:node-operators-registry",
  "lidoLocator",
  "stakingRouter",
  "daoInitialSettings",
  "eip712StETH",
  "accountingOracle",
  "legacyOracle",
  "hashConsensusForAccounting",
  "validatorsExitBusOracle",
  "hashConsensusForValidatorsExitBus",
  "withdrawalQueueERC721",
  "withdrawalVault",
  "nodeOperatorsRegistry",
]


async function deployNewContracts({ web3, artifacts }) {
  const netId = await web3.eth.net.getId()
  logWideSplitter()
  log(`Network ID:`, yl(netId))

  let state = readNetworkState(network.name, netId)
  assertRequiredNetworkState(state, REQUIRED_NET_STATE)

  const agent = state["app:aragon-agent"].proxyAddress
  const votingAddress = state["app:aragon-voting"].proxyAddress
  const lidoAddress = state["app:lido"].proxyAddress
  const legacyOracleAddress = state["app:oracle"].proxyAddress
  const nodeOperatorsRegistryAddress = state["app:node-operators-registry"].proxyAddress
  const nodeOperatorsRegistryParams = state["nodeOperatorsRegistry"].parameters

  const validatorsExitBusOracleParams = state["validatorsExitBusOracle"].parameters
  const accountingOracleParams = state["accountingOracle"].parameters

  const stakingRouterAddress = state["stakingRouter"].address
  const withdrawalQueueAddress = state["withdrawalQueueERC721"].address
  const lidoLocatorAddress = state["lidoLocator"].address
  const accountingOracleAddress = state["accountingOracle"].address
  const hashConsensusForAccountingAddress = state["hashConsensusForAccounting"].address
  const ValidatorsExitBusOracleAddress = state["validatorsExitBusOracle"].address
  const hashConsensusForValidatorsExitBusOracleAddress = state["hashConsensusForValidatorsExitBus"].address
  const eip712StETHAddress = state["eip712StETH"].address
  const withdrawalVaultAddress = state["withdrawalVault"].address

  const testnetAdmin = DEPLOYER
  const accountingOracleAdmin = testnetAdmin
  const exitBusOracleAdmin = testnetAdmin
  const stakingRouterAdmin = testnetAdmin
  const withdrawalQueueAdmin = testnetAdmin

  //
  // === NodeOperatorsRegistry: initialize ===
  //
  // https://github.com/ethereum/solidity-examples/blob/master/docs/bytes/Bytes.md#description
  const stakingModuleTypeId = web3.utils.padRight(web3.utils.stringToHex(
    nodeOperatorsRegistryParams.stakingModuleTypeId
  ), 64)
  const nodeOperatorsRegistryArgs = [
    lidoLocatorAddress,
    stakingModuleTypeId,
    nodeOperatorsRegistryParams.stuckPenaltyDelay,
  ]
  const nodeOperatorsRegistry = await artifacts.require('NodeOperatorsRegistry').at(nodeOperatorsRegistryAddress)
  await nodeOperatorsRegistry.initialize(
    ...nodeOperatorsRegistryArgs,
    { from: DEPLOYER },
  )

  //
  // === Lido: initialize ===
  //
  const lidoInitArgs = [
    lidoLocatorAddress,
    eip712StETHAddress,
  ]
  console.log({ lidoInitArgs })
  const bootstrapInitBalance = 10 // wei
  const lido = await artifacts.require('Lido').at(lidoAddress)
  await lido.initialize(...lidoInitArgs, { value: bootstrapInitBalance, from: DEPLOYER })
  logWideSplitter()

  //
  // === LegacyOracle: initialize ===
  //
  const legacyOracleArgs = [
    lidoLocatorAddress,
    hashConsensusForAccountingAddress,
  ]
  console.log({legacyOracleArgs})
  const legacyOracle = await artifacts.require('LegacyOracle').at(legacyOracleAddress)
  await legacyOracle.initialize(...legacyOracleArgs, { from: DEPLOYER })

  const zeroLastProcessingRefSlot = 0

  //
  // === AccountingOracle: initialize ===
  //
  //! NB: LegacyOracle must be initialized before
  const accountingOracle = await artifacts.require('AccountingOracle').at(accountingOracleAddress)
  const accountingOracleArgs = [
    accountingOracleAdmin,
    hashConsensusForAccountingAddress,
    accountingOracleParams.consensusVersion,
    zeroLastProcessingRefSlot,
  ]
  console.log({accountingOracleArgs})
  await accountingOracle.initializeWithoutMigration(...accountingOracleArgs, { from: DEPLOYER })

  //
  // === ValidatorsExitBusOracle: initialize ===
  //
  const ValidatorsExitBusOracle = await artifacts.require('ValidatorsExitBusOracle').at(ValidatorsExitBusOracleAddress)
  const validatorsExitBusOracleArgs = [
    exitBusOracleAdmin,  // admin
    hashConsensusForValidatorsExitBusOracleAddress,
    validatorsExitBusOracleParams.consensusVersion,
    zeroLastProcessingRefSlot,
  ]
  await ValidatorsExitBusOracle.initialize(...validatorsExitBusOracleArgs, { from: DEPLOYER })

  //
  // === WithdrawalQueue initialize ===
  //
  const withdrawalQueueArgs = [
    withdrawalQueueAdmin,  // _admin
  ]
  console.log({ withdrawalQueueArgs })
  const withdrawalQueue = await artifacts.require('WithdrawalQueueERC721').at(withdrawalQueueAddress)
  await withdrawalQueue.initialize(
    ...withdrawalQueueArgs,
    { from: DEPLOYER },
  )

  //
  // === StakingRouter: initialize ===
  //
  const withdrawalCredentials = `0x010000000000000000000000${withdrawalVaultAddress.slice(2)}`
  console.log({withdrawalCredentials})
  const stakingRouterArgs = [
    stakingRouterAdmin,  // _admin
    lidoAddress,  // _lido
    withdrawalCredentials,  // _withdrawalCredentials
  ]
  console.log({ stakingRouterArgs })
  const stakingRouter = await artifacts.require('StakingRouter').at(stakingRouterAddress)
  await stakingRouter.initialize(
    ...stakingRouterArgs,
    { from: DEPLOYER },
  )
  logWideSplitter()

}

module.exports = runOrWrapScript(deployNewContracts, module)
