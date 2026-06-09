// /app/src/components/admin/ImportModule.tsx

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/button";

interface ImportModuleProps {
  title: string;
  apiEndpoint: string;
  returnUrl: string;
}

const ImportModule = ({ title, apiEndpoint, returnUrl }: ImportModuleProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const router = useRouter();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFile(e.target.files[0]);
      setIsFinished(false); // Reset on new file selection
    }
  };

  const handleImport = async () => {
    if (!file) {
      toast.error("Please select a file to import.");
      return;
    }

    setIsImporting(true);
    setIsFinished(false);
    const toastId = toast.loading("Uploading and processing file... This may take a moment.");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await axios.post(apiEndpoint, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      });
      toast.update(toastId, {
        render: response.data.message,
        type: "success",
        isLoading: false,
        autoClose: 5000,
      });
      setIsFinished(true);
    } catch (error) {
      const errorMessage =
        axios.isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : "An unknown error occurred during import.";
      toast.update(toastId, {
        render: errorMessage,
        type: "error",
        isLoading: false,
        autoClose: 5000,
      });
    } finally {
      setIsImporting(false);
      setFile(null);
      const fileInput = document.getElementById("file-upload") as HTMLInputElement;
      if (fileInput) {
        fileInput.value = "";
      }
    }
  };

  const getButton = () => {
    if (isFinished) {
      return (
        <Button variant="secondary" onClick={() => router.push(returnUrl)}>
          Finished. Go Back.
        </Button>
      );
    }
    return (
      <Button onClick={handleImport} disabled={isImporting || !file}>
        {isImporting ? "Importing..." : `Import ${title}`}
      </Button>
    );
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md font-serif">
      <div className="mb-4">
        <label htmlFor="file-upload" className="block text-sm font-serif text-sh-blue mb-1">
          Select CSV File
        </label>
        <input
          id="file-upload"
          type="file"
          accept=".csv,.xlsx"
          onChange={handleFileChange}
          className="mt-1 block w-full text-sm text-sh-black border border-sh-gray rounded-lg cursor-pointer bg-sh-linen focus:outline-none file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-sh-blue file:text-white hover:file:bg-sh-black"
        />
      </div>
      {getButton()}
    </div>
  );
};

export default ImportModule;
