"use client";

import { useParams } from "next/navigation";
import { ApartmentEditor } from "../../../workspace/apartment-editor";
import { Workspace } from "../../../workspace/workspace";

export default function EditApartmentPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Workspace
      page={{
        section: "Apartments",
        title: "Edit apartment",
        description: "Update the listing and photos. Price and capacity changes apply to new bookings only.",
        permission: "rooms:create",
        render: (props) => <ApartmentEditor {...props} apartmentId={id} />,
      }}
    />
  );
}
