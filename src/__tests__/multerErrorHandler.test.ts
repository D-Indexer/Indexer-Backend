import multer from 'multer';
import { multerErrorHandler } from '../middleware/multerErrorHandler';
import { mockResponse } from './testUtils';

describe('multer error handler', () => {
  it('maps file size errors to bad requests', () => {
    const next = jest.fn();

    multerErrorHandler(new multer.MulterError('LIMIT_FILE_SIZE'), {} as any, mockResponse(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'File exceeds 10 MB limit',
      })
    );
  });

  it('passes through non-multer errors', () => {
    const next = jest.fn();
    const err = new Error('boom');

    multerErrorHandler(err, {} as any, mockResponse(), next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
