// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { OracleReportSanityChecker, LimitsList } from "../../../contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";

contract OracleReportSanityCheckerWrapper is OracleReportSanityChecker {

    constructor(
        address _lidoLocator,
        address _admin,
        LimitsList memory _limitsList,
        ManagersRoster memory _managersRoster,
        address _fuseCommittee,
        address _negativeRebaseOracleAddr
    ) OracleReportSanityChecker(
        _lidoLocator,
        _admin,
        _limitsList,
        _managersRoster,
        _fuseCommittee,
        _negativeRebaseOracleAddr
    ) {}

    function addRebaseValue(uint64 rebaseValue, uint32 refSlot) public {
        _addRebaseValue(rebaseValue, refSlot);
    }

}
