const fs = require('fs')
const path = require('path')

const { log } = require('./log')

const NETWORK_STATE_FILE_BASENAME = process.env.NETWORK_STATE_FILE_BASENAME || 'deployed'
const NETWORK_STATE_FILE_DIR = process.env.NETWORK_STATE_FILE_DIR || '.'

function readNetworkState(netName, netId) {
  const fileName = _getFileName(netName, NETWORK_STATE_FILE_BASENAME, NETWORK_STATE_FILE_DIR)
  const state = _readNetworkStateFile(fileName, netId)
  return state
}

function persistNetworkState(netName, netId, state, updates = undefined) {
  state.networkId = netId
  if (updates) {
    updateNetworkState(state, updates)
  }
  const fileName = _getFileName(netName, NETWORK_STATE_FILE_BASENAME, NETWORK_STATE_FILE_DIR)
  _writeNetworkStateFile(fileName, state)
}

function persistNetworkState2(netName, netId, state, updates = undefined) {
  state.networkId = netId
  if (updates) {
    updateNetworkState2(state, updates)
  }
  const fileName = _getFileName(netName, NETWORK_STATE_FILE_BASENAME, NETWORK_STATE_FILE_DIR)
  _writeNetworkStateFile(fileName, state)
}

function updateNetworkState2(state, newState) {
  Object.keys(newState).forEach((key) => {
    const previousValue = state[key]
    const value = newState[key]
    if (value != null) {
      state[key] = Object.assign(previousValue || {}, value)
    }
  })
}

function updateNetworkState(state, newState) {
  Object.keys(newState).forEach((key) => {
    const value = newState[key]
    if (value != null) {
      if (value.address) {
        state[`${key}Address`] = value.address
        if (value.constructorArgs) {
          state[`${key}ConstructorArgs`] = value.constructorArgs
        }
      } else {
        state[key] = value
      }
    }
  })
}

function assertRequiredNetworkState(state, requiredStateNames) {
  const missingState = requiredStateNames.filter((key) => !state[key])
  if (missingState.length) {
    const missingDesc = missingState.join(', ')
    throw new Error(
      `missing following fields from the network state file, make sure you've run ` + `previous deployment steps: ${missingDesc}`
    )
  }
}

function _getFileName(netName, baseName, dir) {
  return path.resolve(dir, `${baseName}-${netName}.json`)
}

function readStateFile(fileName) {
  const data = fs.readFileSync(fileName, 'utf8')
  try {
    return JSON.parse(data)
  } catch (err) {
    throw new Error(`malformed network state file ${fileName}: ${err.message}`)
  }
}

function _readNetworkStateFile(fileName, netId) {
  if (!fs.existsSync(fileName)) {
    const state = { networkId: netId }
    _writeNetworkStateFile(fileName, state)
    return state
  }
  return readStateFile(fileName)
}

function sortKeysAlphabetically(object) {
  const sortedObject = {}
  const sortedKeys = Object.keys(object).sort()
  for (const key of sortedKeys) {
    sortedObject[key] = object[key]
  }
  return sortedObject
}

function _writeNetworkStateFile(fileName, state) {
  const stateSorted = sortKeysAlphabetically(state)
  const data = JSON.stringify(stateSorted, null, '  ')
  fs.writeFileSync(fileName, data + '\n', 'utf8')
}

module.exports = {
  readNetworkState,
  persistNetworkState,
  persistNetworkState2,
  updateNetworkState,
  assertRequiredNetworkState,
  readStateFile,
}
