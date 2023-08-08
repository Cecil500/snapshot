import { upload as pin } from '@snapshot-labs/pineapple';
import { useI18n } from './useI18n';

const isUploadingImage = ref(false);

export function useImageUpload() {
  const imageUploadError = ref('');
  const imageUrl = ref('');
  const imageName = ref('');

  const { t } = useI18n();
  const { notify } = useFlashNotification();

  const reset = () => {
    isUploadingImage.value = false;
    imageUploadError.value = '';
    imageUrl.value = '';
    imageName.value = '';
  };

  const upload = async (
    file,
    onSuccess: (image: { name: string; url: string }) => void
  ) => {
    reset();
    if (!file) return;
    isUploadingImage.value = true;
    const formData = new FormData();

    // TODO: Make this composable useFileUpload

    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(file.type)) {
      imageUploadError.value = t('errors.unsupportedImageType');
      isUploadingImage.value = false;
      notify(['red', t('errors.unsupportedImageType')]);
      return;
    }
    if (file.size > 1024 * 1024) {
      imageUploadError.value = t('errors.fileTooBig');
      isUploadingImage.value = false;
      notify(['red', t('errors.fileTooBig')]);
      return;
    }
    formData.append('file', file);
    try {
      console.log(file);
      const receipt = await pin(formData);
      imageUrl.value = `ipfs://${receipt.cid}`;
      imageName.value = file.name;
      onSuccess({ name: file.name, url: imageUrl.value });
    } catch (err) {
      notify(['red', t('notify.somethingWentWrong')]);
      imageUploadError.value = (err as Error).message;
    } finally {
      isUploadingImage.value = false;
    }
  };

  return {
    isUploadingImage,
    imageUploadError,
    image: {
      url: imageUrl,
      name: imageName
    },
    upload
  };
}
