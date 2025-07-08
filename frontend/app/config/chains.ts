export interface Chain {
  value: string;
  label: string;
  icon: string;
  type: string;
  supportedInterfaces: string[];
}

export const chains: Chain[] = [
  { value: "arbitrum", label: "Arbitrum Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/arbitrum-one.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "arbitrumn", label: "Arbitrum Nova", icon: "https://info-mainnet.lavanet.xyz/icons/arbitrum-nova.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "arbitrums", label: "Arbitrum Sepolia Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/arbitrum-nova.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "avax", label: "Avalanche Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/avalanche.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "avaxt", label: "Avalanche Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/avalanche.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "axelar", label: "Axelar Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/axelar.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "axelart", label: "Axelar Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/axelar.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "base", label: "Base Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/base.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "bases", label: "Base Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/base.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "blast", label: "Blast Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/blast.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "blastsp", label: "Blast Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/blast.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "celo", label: "Celo Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/celo.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "alfajores", label: "Celo Alfajores", icon: "https://info-mainnet.lavanet.xyz/icons/celo.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "cosmoshub", label: "Cosmos Hub Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/cosmos-hub.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "cosmoshubt", label: "Cosmos Hub Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/cosmos-hub.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "eth1", label: "Ethereum Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/ethereum.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "sep1", label: "Ethereum Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/ethereum.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "hol1", label: "Ethereum Holesky", icon: "https://info-mainnet.lavanet.xyz/icons/ethereum.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "hyperliquid", label: "Hyperliquid Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/HL-green.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "hyperliquidt", label: "Hyperliquid Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/HL-green.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "evmos", label: "Evmos Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/evmos.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "jsonrpc", "grpc"] },
  { value: "evmost", label: "Evmos Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/evmos.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "jsonrpc", "grpc"] },
  { value: "ftm250", label: "Fantom Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/fantom.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "ftm4002", label: "Fantom Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/fantom.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "fuse", label: "Fuse Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/fuse.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "spark", label: "Fuse Spark", icon: "https://info-mainnet.lavanet.xyz/icons/fuse.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "fvm", label: "Filecoin Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/filecoin.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "fvmt", label: "Filecoin Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/filecoin.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "lava", label: "Lava Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/lava.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "lav1", label: "Lava Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/lava.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "movement", label: "Movement Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/movement.svg", type: "cosmos", supportedInterfaces: ["rest"] },
  { value: "movementt", label: "Movement Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/movement.svg", type: "cosmos", supportedInterfaces: ["rest"] },
  { value: "near", label: "NEAR Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/near.svg", type: "near", supportedInterfaces: ["jsonrpc"] },
  { value: "neart", label: "NEAR Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/near.svg", type: "near", supportedInterfaces: ["jsonrpc"] },
  { value: "optm", label: "Optimism Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/optimism.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "optms", label: "Optimism Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/optimism.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "polygon", label: "Polygon Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/polygon-pos.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "polygona", label: "Polygon Amoy", icon: "https://info-mainnet.lavanet.xyz/icons/polygon-pos.svg", type: "evm", supportedInterfaces: ["jsonrpc"] },
  { value: "solana", label: "Solana Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/solana.svg", type: "solana", supportedInterfaces: ["jsonrpc"] },
  { value: "solanat", label: "Solana Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/solana.svg", type: "solana", supportedInterfaces: ["jsonrpc"] },
  { value: "strgz", label: "Stargaze Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/stargaze.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "strgzt", label: "Stargaze Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/stargaze.svg", type: "cosmos", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "strk", label: "Starknet Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/starknet.svg", type: "starknet", supportedInterfaces: ["jsonrpc"] },
  { value: "strks", label: "Starknet Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/starknet.svg", type: "starknet", supportedInterfaces: ["jsonrpc"] }
]; 