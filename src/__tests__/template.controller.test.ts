import { getOne, list } from '../controllers/template.controller';
import * as templateService from '../services/template';
import { invokeHandler, mockResponse } from './testUtils';

jest.mock('../services/template');

const mockTemplateService = templateService as jest.Mocked<typeof templateService>;

describe('template controller', () => {
  afterEach(() => jest.clearAllMocks());

  it('lists templates', async () => {
    const templates = [{ id: 1, metadataCid: 'QmTemplate', deprecated: false, createdAt: new Date() }];
    mockTemplateService.listTemplates.mockResolvedValue(templates);
    const res = mockResponse();

    const { next } = await invokeHandler(list, {}, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(templates);
  });

  it('rejects non-numeric template ids', async () => {
    const { next } = await invokeHandler(getOne, { params: { id: 'abc' } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns one template', async () => {
    const template = { id: 2, metadataCid: 'QmTemplate', deprecated: false, createdAt: new Date() };
    mockTemplateService.getTemplate.mockResolvedValue(template);
    const res = mockResponse();

    const { next } = await invokeHandler(getOne, { params: { id: '2' } }, res);

    expect(next).not.toHaveBeenCalled();
    expect(mockTemplateService.getTemplate).toHaveBeenCalledWith(2);
    expect(res.json).toHaveBeenCalledWith(template);
  });

  it('returns not found for missing templates', async () => {
    mockTemplateService.getTemplate.mockResolvedValue(null);

    const { next } = await invokeHandler(getOne, { params: { id: '99' } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});
