// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAavePool
 * @notice Minimal interface for Aave V3 Pool flash loan functionality
 */
interface IAavePool {
    /**
     * @notice Executes a simple flash loan (single asset)
     * @param receiverAddress The contract that will receive the flash loaned amount
     * @param asset The address of the token to flash loan
     * @param amount The amount to flash loan
     * @param params Arbitrary bytes to pass to the receiver
     * @param referralCode Referral code (use 0)
     */
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @notice Returns the fee percentage for flash loans
     * @return The fee in basis points (e.g., 5 = 0.05%)
     */
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}
