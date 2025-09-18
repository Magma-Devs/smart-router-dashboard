export interface ChainTypeInterface {
  [key: string]: string;
}

export interface ChainType {
  value: string;
  label: string;
  interfaces: ChainTypeInterface;
}

export const chainTypes: ChainType[] = [
  {
    value: 'evm',
    label: 'EVM',
    interfaces: {
      jsonrpc: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
    },
  },
  {
    value: 'near',
    label: 'NEAR',
    interfaces: {
      jsonrpc: '{"jsonrpc":"2.0","method":"block","params":{"finality":"final"},"id":1}',
    },
  },
  {
    value: 'solana',
    label: 'Solana',
    interfaces: {
      jsonrpc: '{"jsonrpc":"2.0","method":"getBlockHeight","params":[],"id":1}',
    },
  },
  {
    value: 'cosmos',
    label: 'Cosmos',
    interfaces: {
      tendermintrpc: '{"jsonrpc":"2.0","method":"status","params":[],"id":1}',
      rest: '{"method":"GET","path":"/cosmos/base/tendermint/v1beta1/blocks/latest"}',
      grpc: '{"method":"/cosmos.base.tendermint.v1beta1.Service/GetLatestBlock"}',
    },
  },
  {
    value: 'starknet',
    label: 'Starknet',
    interfaces: {
      jsonrpc: '{"jsonrpc":"2.0","method":"starknet_blockNumber","params":[],"id":1}',
    },
  },
  {
    value: 'tron',
    label: 'Tron',
    interfaces: {
      rest: '{"method":"GET","path":"/wallet/getnodeinfo"}',
    },
  },
];
