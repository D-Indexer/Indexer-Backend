import { getOne, list } from '../controllers/template.controller';
import * as templateService from '../services/template';
import { invokeHandler, mockResponse } from './testUtils';

jest.mock('../services/template');

const mockTemplateService = templateService as jest.Mocked<typeof templateService>;
const template = { id: 2, metadataUri: 'ipfs://bafy', creator: 'GADMIN', registeredAt: new Date() };

describe('template controller', () => {
  afterEach(() => jest.clearAllMocks());

  it('lists templates', async () => {
    mockTemplateService.listTemplates.mockResolvedValue([template]);
    const res = mockResponse();

    const { next } = await invokeHandler(list, {}, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([template]);
  });

  it('rejects non-numeric template ids', async () => {
    const { next } = await invokeHandler(getOne, { params: { id: 'abc' } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it.each(['4294967296', '99999999999', '1'.repeat(400)])(
    'rejects template id %s outside the u32 range with 400 instead of a database error',
    async (id) => {
      const { next } = await invokeHandler(getOne, { params: { id } });

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(mockTemplateService.getTemplate).not.toHaveBeenCalled();
    }
  );

  it('returns one template', async () => {
    mockTemplateService.getTemplate.mockResolvedValue(template);
    const res = mockResponse();

    const { next } = await invokeHandler(getOne, { params: { id: '2' } }, res);

    expect(next).not.toHaveBeenCalled();
    expect(mockTemplateService.getTemplate).toHaveBeenCalledWith(2);
    expect(res.json).toHaveBeenCalledWith(template);
  });

  it('accepts the largest u32 template id', async () => {
    mockTemplateService.getTemplate.mockResolvedValue(null);

    await invokeHandler(getOne, { params: { id: '4294967295' } });

    expect(mockTemplateService.getTemplate).toHaveBeenCalledWith(4294967295);
  });

  it('returns not found for missing templates', async () => {
    mockTemplateService.getTemplate.mockResolvedValue(null);

    const { next } = await invokeHandler(getOne, { params: { id: '99' } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});
