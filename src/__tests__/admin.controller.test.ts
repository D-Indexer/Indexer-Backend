import { list } from '../controllers/admin.controller';
import * as adminService from '../services/admin';
import { invokeHandler, mockResponse } from './testUtils';

jest.mock('../services/admin');

const mockAdminService = adminService as jest.Mocked<typeof adminService>;
const admin = { address: 'GADMIN', addedAt: new Date('2026-11-09T22:14:42Z') };

describe('admin controller', () => {
  afterEach(() => jest.clearAllMocks());

  it('lists admins', async () => {
    mockAdminService.listAdmins.mockResolvedValue([admin]);
    const res = mockResponse();

    const { next } = await invokeHandler(list, {}, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([admin]);
  });
});
