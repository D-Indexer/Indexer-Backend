export const mockAdd = jest.fn();
export const mockPinAdd = jest.fn();

export const create = jest.fn(() => ({
  add: mockAdd,
  pin: {
    add: mockPinAdd,
  },
}));
