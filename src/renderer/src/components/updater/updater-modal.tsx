import {
  Button,
  Code,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/react'
import ReactMarkdown from 'react-markdown'
import React from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  version: string
  changelog: string
  onClose: () => void
}

const UpdaterModal: React.FC<Props> = (props) => {
  const { version, changelog, onClose } = props
  const { t } = useTranslation()

  return (
    <Modal
      backdrop="blur"
      classNames={{ backdrop: 'top-[48px]' }}
      hideCloseButton
      isOpen={true}
      onOpenChange={onClose}
      scrollBehavior="inside"
    >
      <ModalContent className="h-full w-[calc(100%-100px)]">
        <ModalHeader className="flex justify-between app-drag">
          <div>{t('common.updater.versionReady', { version })}</div>
          <Button
            color="primary"
            size="sm"
            className="flex app-nodrag"
            onPress={() => {
              open(`https://github.com/mihomo-party-org/mihomo-party/releases/tag/v${version}`)
            }}
          >
            {t('common.updater.goToDownload')}
          </Button>
        </ModalHeader>
        <ModalBody className="h-full">
          <div className="markdown-body select-text">
            <ReactMarkdown
              components={{
                a: ({ ...props }) => <a target="_blank" className="text-primary" {...props} />,
                code: ({ children }) => <Code size="sm">{children}</Code>,
                h3: ({ ...props }) => <h3 className="text-lg font-bold" {...props} />,
                li: ({ children }) => <li className="list-disc list-inside">{children}</li>
              }}
            >
              {changelog}
            </ReactMarkdown>
          </div>
        </ModalBody>
        <ModalFooter className="flex-col gap-2 items-stretch">
          <p className="text-warning text-sm">{t('common.updater.forkNotice')}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" color="primary" onPress={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default UpdaterModal
