/** 데모용 MockVRFCoordinatorV2Plus */
export const mockVrfAbi = [
  {
    type: 'function',
    name: 'fulfill',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestId', type: 'uint256' },
      { name: 'randomWord', type: 'uint256' },
    ],
    outputs: [],
  },
] as const
