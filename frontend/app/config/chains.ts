export interface Chain {
  value: string;
  label: string;
  icon: string;
  supportedInterfaces: string[];
}

export const chains: Chain[] = [
  { value: "arbitrum", label: "Arbitrum Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/arbitrum-one.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "arbitrumn", label: "Arbitrum Nova", icon: "https://info-mainnet.lavanet.xyz/icons/arbitrum-nova.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "arbitrums", label: "Arbitrum Sepolia Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/arbitrum-nova.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "avax", label: "Avalanche Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/avalanche.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "avaxt", label: "Avalanche Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/avalanche.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "axelar", label: "Axelar Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/axelar.svg", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "axelart", label: "Axelar Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/axelar.svg", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "base", label: "Base Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/base.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "bases", label: "Base Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/base.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "blast", label: "Blast Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/blast.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "blastsp", label: "Blast Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/blast.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "celo", label: "Celo Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/celo.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "alfajores", label: "Celo Alfajores", icon: "https://info-mainnet.lavanet.xyz/icons/celo.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "cosmoshub", label: "Cosmos Hub Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/cosmos-hub.svg", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "cosmoshubt", label: "Cosmos Hub Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/cosmos-hub.svg", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "eth1", label: "Ethereum Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/ethereum.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "sep1", label: "Ethereum Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/ethereum.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "hol1", label: "Ethereum Holesky", icon: "https://info-mainnet.lavanet.xyz/icons/ethereum.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "evmos", label: "Evmos Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/evmos.svg", supportedInterfaces: ["rest", "tendermintrpc", "jsonrpc", "grpc"] },
  { value: "evmost", label: "Evmos Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/evmos.svg", supportedInterfaces: ["rest", "tendermintrpc", "jsonrpc", "grpc"] },
  { value: "ftm250", label: "Fantom Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/fantom.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "ftm4002", label: "Fantom Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/fantom.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "fuse", label: "Fuse Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/fuse.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "spark", label: "Fuse Spark", icon: "https://info-mainnet.lavanet.xyz/icons/fuse.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "fvm", label: "Filecoin Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/filecoin.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "fvmt", label: "Filecoin Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/filecoin.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "lava", label: "Lava Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/lava.svg", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "lav1", label: "Lava Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/lava.svg", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "movement", label: "Movement Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/movement.svg", supportedInterfaces: ["rest"] },
  { value: "movementt", label: "Movement Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/movement.svg", supportedInterfaces: ["rest"] },
  { value: "near", label: "NEAR Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/near.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "neart", label: "NEAR Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/near.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "optm", label: "Optimism Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/optimism.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "optms", label: "Optimism Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/optimism.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "polygon", label: "Polygon Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/polygon-pos.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "polygona", label: "Polygon Amoy", icon: "https://info-mainnet.lavanet.xyz/icons/polygon-pos.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "solana", label: "Solana Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/solana.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "solanat", label: "Solana Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/solana.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "strgz", label: "Stargaze Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/stargaze.svg", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "strgzt", label: "Stargaze Testnet", icon: "https://info-mainnet.lavanet.xyz/icons/stargaze.svg", supportedInterfaces: ["rest", "tendermintrpc", "grpc"] },
  { value: "strk", label: "Starknet Mainnet", icon: "https://info-mainnet.lavanet.xyz/icons/starknet.svg", supportedInterfaces: ["jsonrpc"] },
  { value: "strks", label: "Starknet Sepolia", icon: "https://info-mainnet.lavanet.xyz/icons/starknet.svg", supportedInterfaces: ["jsonrpc"] }
]; 