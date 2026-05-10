// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MaliciousToken (Honeypot Mock)
 * @notice Simulates a honeypot token that allows incoming transfers
 *         but reverts on any outbound transfer (trapping funds).
 * @dev Used exclusively in IronShield test suite to validate honeypot detection.
 *      Implements minimal ERC20 interface with Transfer/Approval events
 *      so that DEX routers and token scanners behave consistently.
 */
contract MaliciousToken {
    string public constant name = "HoneypotToken";
    string public constant symbol = "HPOT";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    // The deployer (attacker) is the only one who can freely transfer out
    address public immutable deployer;

    // Standard ERC20 events (required for router compatibility)
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error HoneypotTriggered(string reason);

    constructor(uint256 _initialSupply) {
        deployer = msg.sender;
        totalSupply = _initialSupply;
        balanceOf[msg.sender] = _initialSupply;
        emit Transfer(address(0), msg.sender, _initialSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /**
     * @notice Transfer tokens - REVERTS for non-deployer senders
     * @dev This is the honeypot trap: tokens go IN but never come OUT
     */
    function transfer(address to, uint256 amount) external returns (bool) {
        // Allow the deployer to move tokens freely (to set up the trap)
        if (msg.sender != deployer) {
            revert HoneypotTriggered("Transfer blocked: honeypot active");
        }
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    /**
     * @notice TransferFrom - REVERTS for non-deployer originators
     * @dev Router calls transferFrom; this traps the arbitrage bot.
     *      The `from` check (not `msg.sender`) is intentional —
     *      routers call transferFrom(victim, router, amount), so
     *      checking `from != deployer` blocks any non-deployer funds.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        if (from != deployer) {
            revert HoneypotTriggered("TransferFrom blocked: honeypot active");
        }
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
